import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import { BridgeIPC } from "../bridge/ipc.ts";
import { parseModelsOutput } from "../discovery/models.ts";
import { createBridgeDriver } from "../drivers/driver.ts";
import type { DriverSession, PrepareDriverInput, RuntimeEvent } from "../drivers/types.ts";
import { Bridge, streamProvider } from "./provider.ts";

test("turn persists its captured session version rather than a later driver selection", async (t) => {
  const bridge = new Bridge({ getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI);
  t.after(() => bridge.liveSessions.disposeAll());
  const sessionId = bridge.piContextAdapter.bind(SessionManager.inMemory(os.tmpdir()));
  const live = bridge.liveSessions.getOrCreate(sessionId);
  const mcp = new BridgeIPC([], live.id, live.resources);
  const version = bridge.driver.sessionVersion;
  let emit!: (event: RuntimeEvent) => void;
  let markSubmitted!: () => void;
  const submitted = new Promise<void>((resolve) => { markSubmitted = resolve; });
  const proc: DriverSession = {
    driver: "acp", isRunning: true, compatibilityKey: "c".repeat(64),
    onRuntimeEvent: (handler) => { emit = handler; return () => {}; },
    serializeContextUpdate: () => "",
    submit: async ({ beforeInput }) => {
      assert.equal(beforeInput(), true);
      emit({ type: "start" });
      emit({ type: "session-reference", reference: "remote-A" });
      emit({ type: "text-delta", delta: "answer" });
      markSubmitted();
    },
    abort: async () => {},
  };
  t.mock.method(bridge.driver, "prepareSession", async ({ preparationId, model }: PrepareDriverInput) => {
    assert.equal(live.setSession(proc, "sync-key", mcp, "remote-A", preparationId), true);
    return { proc, mcpServer: mcp, reconstructContext: true, modelId: model.id };
  });
  const context: Context = { tools: [], messages: [{ role: "user", content: "question", timestamp: 1 }] };
  const model = parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)")[0]!;
  const stream = streamProvider(model, context, { sessionId }, bridge);
  const collecting = (async () => {
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
  })();
  await submitted;

  bridge.driver = createBridgeDriver("cli");
  emit({ type: "complete", reason: "stop", resumable: true });
  const events = await collecting;

  assert.equal(events.at(-1)?.type, "done");
  const saved = await bridge.runtimeSessionStore.get(sessionId, version);
  assert.equal(saved?.sessionId, "remote-A");
  assert.equal(saved?.version, version);
  assert.equal(saved?.compatibilityKey, proc.compatibilityKey);
  assert.equal(saved?.messageCount, 2);
  assert.equal(await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion), undefined);
});
