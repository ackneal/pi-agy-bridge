import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BridgeIPC } from "../bridge/bridge-ipc.ts";
import { AgyRuntime } from "../runtime/process.ts";
import { AgyBridge, streamAgyProvider } from "./provider.ts";

const cases = [
  { stage: "bridge.start", aborts: 0, cancelled: false },
  { stage: "plugin install", aborts: 0, cancelled: false },
  { stage: "proc.start", aborts: 1, cancelled: false },
  { stage: "waitForConnection", aborts: 1, cancelled: false },
  { stage: "proc.start", aborts: 2, cancelled: true },
  { stage: "waitForConnection", aborts: 2, cancelled: true },
] as const;

for (const { stage, aborts, cancelled } of cases) {
  test(`streamAgyProvider cleans up after ${stage} ${cancelled ? "cancellation" : "failure"}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-runtime-start-"));
    t.after(async () => {
      t.mock.restoreAll();
      await rm(directory, { recursive: true, force: true });
    });
    const agyPath = path.join(directory, "agy");
    await writeFile(agyPath, '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo 1.2.14\nelse\n  exit 1\nfi\n', { mode: 0o755 });

    const failure = new Error(`injected ${stage} failure`);
    const controller = new AbortController();
    const startBridge = t.mock.method(BridgeIPC.prototype, "start", async function (this: BridgeIPC) {
      // Supply the endpoint required by the real processEnvironment getter without opening a socket.
      (this as unknown as { socketPath: string }).socketPath = path.join(directory, "bridge.sock");
      if (stage === "bridge.start") throw failure;
    });
    const close = t.mock.method(BridgeIPC.prototype, "close", async () => {});
    const wait = t.mock.method(BridgeIPC.prototype, "waitForConnection", async () => {
      if (stage === "waitForConnection") {
        if (cancelled) controller.abort(failure);
        throw failure;
      }
    });
    const startProc = t.mock.method(AgyRuntime.prototype, "start", async () => {
      if (stage === "proc.start") {
        if (cancelled) controller.abort(failure);
        throw failure;
      }
      return { event: "init", conversation_id: "test-conversation" } as Awaited<ReturnType<AgyRuntime["start"]>>;
    });
    const abort = t.mock.method(AgyRuntime.prototype, "abort", async () => {});
    const install = t.mock.method(AgyBridge.prototype, "ensureAgyPluginInstalled", async () => {
      if (stage === "plugin install") throw failure;
    });

    const pi = {
      on: () => {},
      registerProvider: () => {},
      registerCommand: () => {},
      getActiveTools: () => [],
      getAllTools: () => [],
    } as unknown as ExtensionAPI;
    const config = { agyPath, pluginDir: path.join(directory, "plugin"), models: [] };
    const bridge = new AgyBridge(pi, config);
    bridge.start();
    const context: Context = { messages: [], tools: [], systemPrompt: "" };
    const model = {
      id: "test-model", name: "Test model", api: "agy", provider: "agy",
      baseUrl: "agy", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192, maxTokens: 1024,
    } as Model<any>;
    const events: AssistantMessageEvent[] = [];
    for await (const event of streamAgyProvider(model, context, { sessionId: `test-${stage}`, signal: controller.signal }, config, bridge)) {
      events.push(event);
      if (event.type === "error" || event.type === "done") break;
    }
    // Termination is emitted before the asynchronous disposal finishes.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const terminal = events.at(-1);
    assert.equal(terminal?.type, "error");
    if (terminal?.type === "error") {
      assert.equal(terminal.error.errorMessage, failure.message);
      assert.equal(terminal.error.stopReason, cancelled ? "aborted" : "error");
    }
    assert.equal(startBridge.mock.callCount(), 1);
    assert.equal(install.mock.callCount(), stage === "bridge.start" ? 0 : 1);
    assert.equal(startProc.mock.callCount(), aborts ? 1 : 0);
    assert.equal(wait.mock.callCount(), stage === "waitForConnection" ? 1 : 0);
    assert.equal(close.mock.callCount(), cancelled ? 2 : 1, "cancelled startup must close IPC before ownership transfers");
    assert.equal(abort.mock.callCount(), aborts, "only a constructed runtime must be aborted");
  });
}
