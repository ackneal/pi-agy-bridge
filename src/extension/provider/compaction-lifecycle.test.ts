import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { BridgeIPC } from "../bridge/ipc.ts";
import { CliDriver } from "../drivers/cli/driver.ts";
import type { BridgeDriver, DriverSession, RuntimeEvent } from "../drivers/types.ts";
import { Bridge } from "./provider.ts";
import { registerAuthHomeFixture } from "./auth-home-fixture.ts";

const model = {
  id: "summary-model", name: "summary-model", provider: "agy", api: "agy", baseUrl: "agy",
  maxTokens: 1024, contextWindow: 8192, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<any>;

for (const action of ["shutdown", "switch", "login"] as const) {
  test(`standalone compaction is cancelled on bridge ${action}`, async (t) => {
    const directory = await registerAuthHomeFixture(t);
    const runtime = await ModelRuntime.create({ modelsPath: null, authPath: path.join(directory, "auth.json"), refreshOnCreate: false });
    let shutdown!: () => Promise<void>;
    let submitted!: () => void;
    const waiting = new Promise<void>((resolve) => { submitted = resolve; });
    let handler: ((event: RuntimeEvent) => void) | undefined;
    let running = true;
    let aborts = 0;
    let ipc: BridgeIPC | undefined;
    const driver: BridgeDriver = {
      id: "acp", label: "acp", sessionVersion: "test:v1", initialModels: [model],
      authentication: { label: "acp", probe: async () => true, login: async () => {} },
      validateSelection() {}, detectExecutable: () => undefined,
      discoverModels: async () => [model], usage: async () => undefined,
      async prepareSession(input) {
        assert.deepEqual(input.tools, []);
        ipc = new BridgeIPC([], input.session.id, input.session.resources);
        const proc: DriverSession = {
          driver: "acp", get isRunning() { return running; },
          onRuntimeEvent(callback) { handler = callback; return () => { handler = undefined; }; },
          formatContextUpdate: () => "",
          abort: async () => { aborts++; running = false; },
          async submit(submission) {
            assert.equal(submission.beforeInput(), true);
            submitted();
          },
        };
        input.session.setSession(proc, "summary", ipc, "summary-conversation", input.preparationId);
        return { proc, mcpServer: ipc, reconstructContext: true, modelId: model.id };
      },
    };
    const bridge = new Bridge({
      on: (name: string, callback: () => Promise<void>) => { if (name === "session_shutdown") shutdown = callback; },
      registerCommand: () => {},
      registerProvider: (provider: Provider) => runtime.registerNativeProvider(provider),
      getActiveTools: () => [], getAllTools: () => [],
    } as unknown as ExtensionAPI, driver);
    const controller = new AbortController();
    t.after(async () => { controller.abort(); await shutdown(); });
    bridge.start();
    await runtime.refresh({ providers: ["agy"], allowNetwork: false });
    const stream = runtime.streamSimple(model, {
      messages: [{ role: "user", content: "Summarize this conversation", timestamp: 1 }],
    }, {
      sessionId: "standalone-summary", cacheRetention: "none",
      apiKey: "agy-bridge:test-epoch", signal: controller.signal,
    });
    const result = stream.result();
    await waiting;
    assert.equal(running, true);
    assert.ok(handler);
    assert.equal(bridge.liveSessions.get("standalone-summary"), undefined);
    const close = t.mock.method(ipc!, "close");

    if (action === "shutdown") await shutdown();
    else if (action === "switch") {
      t.mock.method(CliDriver.prototype, "detectExecutable", () => "/mock/cli");
      t.mock.method(CliDriver.prototype, "discoverModels", async () => [model]);
      await bridge.switchDriver("cli");
    } else {
      await runtime.login("agy", "oauth", {
        signal: new AbortController().signal,
        notify: () => {}, prompt: async () => { throw new Error("Unexpected login prompt"); },
      });
    }

    assert.equal((await result).stopReason, "aborted");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(controller.signal.aborted, false, "bridge cancellation must not require caller cancellation");
    assert.equal(running, false);
    assert.equal(aborts, 1);
    assert.equal(close.mock.callCount(), 1);
    assert.equal(handler, undefined);
  });
}
