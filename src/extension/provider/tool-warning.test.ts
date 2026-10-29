import assert from "node:assert/strict";
import test from "node:test";
import { BridgeIPC } from "../bridge/ipc.ts";
import type { DriverSession, RuntimeEvent } from "../drivers/types.ts";
import { LiveSession, PiContextAdapter } from "../session/session.ts";
import { RuntimeSessionStore, RuntimeSessionSync } from "../session/state.ts";
import { PiRuntimeOutput } from "./output.ts";
import { Turn } from "./turn.ts";

for (const row of [
  { name: "active output", handoff: false, throws: false },
  { name: "between Pi tool turns", handoff: true, throws: false },
  { name: "failed warning display", handoff: false, throws: true },
]) {
  test(`ACP warning does not invalidate runtime: ${row.name}`, async (t) => {
    const session = new LiveSession("warning-session");
    t.after(() => session.dispose());
    let dispatch!: (event: RuntimeEvent) => void;
    const abort = t.mock.fn(async () => {});
    const proc: DriverSession = {
      driver: "acp", isRunning: true,
      onRuntimeEvent(handler) { dispatch = handler; return () => {}; },
      formatContextUpdate: () => "", submit: async () => {}, abort,
    };
    const mcpServer = new BridgeIPC([], session.id, session.resources);
    const close = t.mock.method(mcpServer, "close");
    const preparationId = session.beginPreparation();
    assert.equal(session.setSession(proc, "sync", mcpServer, "native-session", preparationId), true);
    const adapter = new PiRuntimeOutput({ model: "synthetic", provider: "agy" });
    const onWarning = t.mock.fn((_name: string, _args: unknown) => {
      if (row.throws) throw new Error("synthetic UI failure");
    });
    const turn = new Turn({
      session, adapter, context: { messages: [] }, sync: new RuntimeSessionSync(),
      store: new RuntimeSessionStore(new PiContextAdapter()), preparationId,
      signal: undefined, sessionVersion: "acp:v1", onWarning,
    });
    turn.attach({ proc, mcpServer });
    if (row.handoff) adapter.handleBridgeToolCalls([{ type: "toolCall", id: "read", name: "read", arguments: {} }]);

    const args = { absolute_path: "/synthetic/output.txt" };
    dispatch({ type: "tool-warning", name: "view_file", args });

    assert.equal(onWarning.mock.callCount(), 1);
    assert.deepEqual(onWarning.mock.calls[0]!.arguments, ["view_file", args]);
    assert.equal(session.activeProcess, proc);
    assert.equal(session.activeMcpServer, mcpServer);
    assert.equal(abort.mock.callCount(), 0);
    assert.equal(close.mock.callCount(), 0);
    assert.equal(adapter.isCompleted(), row.handoff);
    if (!row.handoff) {
      dispatch({ type: "text-delta", delta: "still working" });
      assert.ok(adapter.message.content.some((part) => part.type === "text" && part.text === "still working"));
    }
  });
}
