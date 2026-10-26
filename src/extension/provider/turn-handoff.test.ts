import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import { BridgeIPC } from "../bridge/ipc.ts";
import type { DriverSession, DriverSubmission, RuntimeEvent } from "../drivers/types.ts";
import { parseModelsOutput } from "../discovery/models.ts";
import { LiveSession, PiContextAdapter } from "../session/session.ts";
import { RuntimeSessionStore, RuntimeSessionSync } from "../session/state.ts";
import { PiRuntimeOutput } from "./output.ts";
import { Turn } from "./turn.ts";

test("delayed submission failure terminates the next turn reusing the same runtime", { timeout: 5000 }, async (t) => {
  const context = new PiContextAdapter();
  const id = context.bind(SessionManager.inMemory(process.cwd()));
  const session = new LiveSession(id);
  const store = new RuntimeSessionStore(context);
  const sync = new RuntimeSessionSync();
  const mcpServer = new BridgeIPC([], session.id, session.resources);
  const invalidate = t.mock.method(store, "delete", store.delete.bind(store));
  const dispose = t.mock.method(session, "dispose", session.dispose.bind(session));
  let handler: ((event: RuntimeEvent) => void) | undefined;
  let rejectOld!: (error: Error) => void;
  const oldSubmission = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
  let finishNext!: () => void;
  const nextSubmission = new Promise<void>((resolve) => { finishNext = resolve; });
  let running = true;
  const abort = t.mock.fn(async () => { running = false; });
  let submissions = 0;
  const proc: DriverSession = {
    driver: "cli",
    get isRunning() { return running; },
    onRuntimeEvent: (next) => {
      handler = next;
      return () => { if (handler === next) handler = undefined; };
    },
    formatContextUpdate: () => "",
    submit: async (input: DriverSubmission) => {
      assert.equal(input.beforeInput(), true);
      submissions++;
      if (submissions === 1) {
        handler!({ type: "complete", reason: "stop", resumable: true });
        await oldSubmission;
      } else {
        await nextSubmission;
      }
    },
    abort,
  };
  session.setSession(proc, "settings", mcpServer, "native-conversation");
  const adapters: PiRuntimeOutput[] = [];
  const sending: Promise<void>[] = [];
  t.after(async () => {
    rejectOld(new Error("test cleanup"));
    finishNext();
    for (const adapter of adapters) adapter.handleTermination("aborted", "test cleanup");
    await Promise.all(sending);
    await session.dispose();
  });
  const model = parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)")[0]!;
  const beginTurn = (messages: Context["messages"]) => {
    const preparationId = session.beginPreparation();
    const adapter = new PiRuntimeOutput({ model: model.id, provider: "agy" });
    adapters.push(adapter);
    const turn = new Turn({
      session, adapter, context: { messages }, sync, store, preparationId,
      signal: undefined, loginEpoch: undefined, sessionVersion: "cli:v1",
    });
    turn.attach({ proc, mcpServer });
    const submitted = turn.send({ model, context: { messages }, options: undefined,
      reconstructContext: false, syncedMessageCount: messages.length }).catch((error) => turn.fail(error));
    sending.push(submitted);
    return { adapter, submitted };
  };
  const old = beginTurn([]);
  const completed = await old.adapter.stream.result();
  assert.equal(completed.stopReason, "stop");
  const next = beginTurn([completed, { role: "user", content: "next request", timestamp: 1 }]);
  assert.equal(submissions, 2);
  assert.equal(session.activeProcess, proc);
  assert.equal(next.adapter.isCompleted(), false);
  const failure = new Error("old submission failed after runtime handoff");

  rejectOld(failure);
  await old.submitted;

  assert.equal(next.adapter.isCompleted(), true, "current output must terminate before its runtime is detached");
  const result = await next.adapter.stream.result();
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, failure.message);
  assert.equal(completed.stopReason, "stop");
  assert.equal(session.activeProcess, null);
  assert.equal(session.activeMcpServer, null);
  assert.equal(handler, undefined);
  assert.equal(invalidate.mock.callCount(), 1);
  assert.equal(dispose.mock.callCount(), 1);
  await dispose.mock.calls[0]!.result;
  assert.equal(abort.mock.callCount(), 1);
  assert.equal(await store.get(id, undefined, "cli:v1"), undefined);
});
