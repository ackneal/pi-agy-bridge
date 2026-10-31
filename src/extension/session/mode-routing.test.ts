import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Context, Model, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import { generateSummaryWithUsage, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BridgeIPC } from "../bridge/ipc.ts";
import { SessionMode, type BridgeDriver, type DriverId, type DriverSession, type PrepareDriverInput, type RuntimeEvent } from "../drivers/types.ts";
import { Bridge, streamProvider } from "../provider/provider.ts";

const model: Model<"agy"> = {
  id: "test", name: "test", api: "agy", provider: "agy", baseUrl: "agy",
  input: ["text"], reasoning: false, maxTokens: 1024, contextWindow: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const tools: Tool[] = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }];
const current: Context = { messages: [{ role: "user", content: "request", timestamp: 1 }] };
const multiple: Context = { messages: [
  { role: "user", content: "first", timestamp: 1 },
  { role: "user", content: "second", timestamp: 2 },
] };

function fixture(t: TestContext, id: DriverId) {
  const preparations: PrepareDriverInput[] = [];
  let aborts = 0;
  const driver: BridgeDriver = {
    id, label: id, sessionVersion: "test:v1", initialModels: [],
    authentication: { label: id, probe: async () => false, login: async () => {} },
    validateSelection() {}, detectExecutable: () => undefined,
    discoverModels: async () => [], usage: async () => undefined,
    async prepareSession(input) {
      preparations.push(input);
      const ipc = new BridgeIPC(input.tools, input.session.id, input.session.resources);
      let running = true;
      let handler: ((event: RuntimeEvent) => void) | undefined;
      const proc: DriverSession = {
        driver: id, get isRunning() { return running; },
        onRuntimeEvent(callback) { handler = callback; return () => { handler = undefined; }; },
        serializeContextUpdate: () => "",
        async submit(submission) {
          if (!submission.beforeInput()) return;
          handler?.({ type: "text-delta", delta: "summary result" });
          handler?.({ type: "complete", reason: "stop", resumable: true });
        },
        async abort() { running = false; aborts++; },
      };
      assert.equal(input.session.setSession(proc, "test", ipc, "native-session", input.preparationId), true);
      return { proc, mcpServer: ipc, reconstructContext: true, modelId: model.id };
    },
  };
  const bridge = new Bridge({} as ExtensionAPI, driver);
  const getTools = t.mock.method(bridge, "getTools", () => tools);
  t.after(async () => {
    await bridge.liveSessions.disposeAll();
    for (const input of preparations) await input.session.dispose();
  });
  return { bridge, preparations, getTools, aborts: () => aborts };
}

interface RoutingCase {
  name: string;
  binding: "bound" | "unbound" | "missing";
  retention?: SimpleStreamOptions["cacheRetention"];
  context: Context;
  expected?: SessionMode;
}

for (const id of ["cli", "acp"] as const) {
  for (const row of [
    { name: "bound conversation", binding: "bound", context: current, expected: SessionMode.Conversation },
    { name: "bound no-cache conversation", binding: "bound", retention: "none", context: current, expected: SessionMode.Conversation },
    { name: "bound empty no-cache conversation", binding: "bound", retention: "none", context: { messages: [] }, expected: SessionMode.Conversation },
    { name: "unbound no-cache request", binding: "unbound", retention: "none", context: current, expected: SessionMode.Standalone },
    { name: "unbound no-cache request with multiple messages", binding: "unbound", retention: "none", context: multiple, expected: SessionMode.Standalone },
    { name: "unbound default-cache request", binding: "unbound", context: current, expected: SessionMode.Conversation },
    { name: "unbound short-cache request", binding: "unbound", retention: "short", context: current, expected: SessionMode.Conversation },
    { name: "unbound long-cache request", binding: "unbound", retention: "long", context: current, expected: SessionMode.Conversation },
    { name: "missing routing id", binding: "missing", retention: "none", context: current },
  ] satisfies RoutingCase[]) {
    test(`${id} SessionMode routing: ${row.name}`, async (t) => {
      const f = fixture(t, id);
      const sessionId = row.binding === "bound" ? f.bridge.piContextAdapter.bind(SessionManager.inMemory())
        : row.binding === "unbound" ? "unbound-routing-id" : undefined;
      const options: SimpleStreamOptions = {
        ...(sessionId ? { sessionId } : {}),
        ...("retention" in row ? { cacheRetention: row.retention } : {}),
      };
      const result = await streamProvider(model, row.context, options, f.bridge).result();
      await new Promise<void>((resolve) => setImmediate(resolve));

      if (row.binding === "missing") {
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /did not provide a sessionId/);
        assert.equal(f.preparations.length, 0);
        return;
      }
      assert.equal(result.stopReason, "stop", result.errorMessage ?? "native completion");
      assert.equal(f.preparations.length, 1);
      const input = f.preparations[0]!;
      assert.equal(input.mode, row.expected);
      const standalone = row.expected === SessionMode.Standalone;
      assert.deepEqual(input.tools, standalone ? [] : tools);
      assert.equal(f.getTools.mock.callCount(), standalone ? 0 : 1);
      assert.equal(f.bridge.liveSessions.get(sessionId!), standalone ? undefined : input.session);
      assert.equal(f.aborts(), standalone ? 1 : 0);
    });
  }

  for (const routing of ["generated", "bound"] as const) {
    test(`${id} Pi summary helper routing: ${routing} id`, async (t) => {
      const f = fixture(t, id);
      const boundId = f.bridge.piContextAdapter.bind(SessionManager.inMemory());
      const request: Parameters<typeof generateSummaryWithUsage> = [current.messages, model, 2048, undefined];
      request[9] = (selected, context, options) => {
        assert.equal(options?.cacheRetention, "none");
        if (routing === "bound") assert.equal(options?.sessionId, boundId);
        else {
          assert.ok(options?.sessionId);
          assert.notEqual(options.sessionId, boundId);
          assert.equal(f.bridge.piContextAdapter.getSessionManager(options.sessionId), undefined);
        }
        return streamProvider(selected, context, options, f.bridge);
      };
      request[13] = routing === "bound" ? boundId : undefined;
      const summary = await generateSummaryWithUsage(...request);
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(summary.text, "summary result");
      assert.equal(f.preparations.length, 1);
      // Pi options do not expose summary purpose. A bound no-cache request is
      // indistinguishable from an ordinary cache-disabled conversation.
      assert.equal(f.preparations[0]!.mode, routing === "generated" ? SessionMode.Standalone : SessionMode.Conversation);
      assert.equal(f.aborts(), routing === "generated" ? 1 : 0);
    });
  }
}
