import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { compact, generateSummaryWithUsage, ModelRuntime, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeContext, type Model, type Provider } from "@earendil-works/pi-ai";
import { BridgeIPC } from "../bridge/ipc.ts";
import type { BridgeDriver, DriverId, DriverSession, RuntimeEvent } from "../drivers/types.ts";
import { Bridge, streamAgyProvider } from "./provider.ts";

const model = {
  id: "summary-model", name: "summary-model", provider: "agy", api: "agy", baseUrl: "agy",
  maxTokens: 1024, contextWindow: 8192, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<any>;

for (const id of ["cli", "acp"] as DriverId[]) {
  for (const outcome of ["success", "error", "blocked-tool", "abort", "delayed-abort", "preparation-error"] as const) {
    test(`${id} standalone native summary: ${outcome}`, async (t) => {
      const controller = new AbortController();
      let disposed = 0;
      let prepared = 0;
      let handler: ((event: RuntimeEvent) => void) | undefined;
      let proc: DriverSession | undefined;
      let submitReturned: (() => void) | undefined;
      const submitted = new Promise<void>((resolve) => { submitReturned = resolve; });
      const driver: BridgeDriver = {
        id, label: id, sessionVersion: "test:v1", initialModels: [],
        authentication: { label: id, probe: async () => false, login: async () => {} },
        validateSelection() {}, detectExecutable: () => undefined,
        discoverModels: async () => [], usage: async () => undefined,
        async prepareSession(input) {
          prepared++;
          assert.deepEqual(input.tools, []);
          assert.equal(await input.store.get(input.session.piSessionId, "test:v1"), undefined);
          await input.store.delete(input.session.piSessionId);
          assert.equal(input.options?.cacheRetention, "none");
          assert.equal(input.context.messages[0]?.role, "system");
          assert.match(JSON.stringify(input.context.messages), /Original conversation detail/);
          assert.deepEqual(input.context.messages, normalizeContext(input.context).messages);
          if (outcome === "preparation-error") throw new Error("preparation rejected");

          const ipc = new BridgeIPC([], input.session.id, input.session.resources);
          let running = true;
          proc = {
            driver: id, get isRunning() { return running; },
            onRuntimeEvent(callback) { handler = callback; return () => { handler = undefined; }; },
            formatContextUpdate: () => "",
            abort: async () => { disposed++; running = false; },
            async submit(submission) {
              assert.equal(submission.reconstructContext, true);
              assert.equal(submission.beforeInput(), true);
              if (outcome === "abort") { controller.abort(); return; }
              if (outcome === "delayed-abort") { submitReturned?.(); return; }
              if (outcome === "blocked-tool") {
                handler?.({ type: "blocked-native-tool", name: "read" });
                return;
              }
              handler?.({ type: "text-delta", delta: "Concise summary" });
              handler?.({ type: "complete", reason: outcome === "error" ? "error" : "stop", error: outcome === "error" ? "backend rejected" : undefined, resumable: false });
            },
          };
          input.session.setSession(proc, "summary", ipc, "summary-conversation", input.preparationId);
          return { proc, mcpServer: ipc, reconstructContext: true, modelId: model.id };
        },
      };
      const bridge = new Bridge({ getActiveTools: () => ["read"], getAllTools: () => [{ name: "read" }] } as unknown as ExtensionAPI, driver);
      t.after(async () => {
        controller.abort();
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (proc?.isRunning) await proc.abort();
      });
      const manager = SessionManager.inMemory();
      const normalId = bridge.piContextAdapter.bind(manager);
      await bridge.runtimeSessionStore.set(normalId, { sessionId: "normal-conversation" }, [], "test:v1");
      const normalBranch = manager.getBranch();
      const persist = t.mock.method(bridge.runtimeSessionStore, "set", async () => { assert.fail("standalone request must not persist a checkpoint"); });
      const lookup = t.mock.method(bridge.runtimeSessionStore, "get", async () => { assert.fail("standalone preparation must not read a checkpoint"); });
      const invalidate = t.mock.method(bridge.runtimeSessionStore, "delete", async () => { assert.fail("standalone request must not invalidate a checkpoint"); });
      t.mock.method(bridge.liveSessions, "getOrCreate", () => { assert.fail("standalone request must not enter live registry"); });

      let streamResult: ReturnType<ReturnType<typeof streamAgyProvider>["result"]> | undefined;
      const summarize = () => generateSummaryWithUsage([{ role: "user", content: "Original conversation detail", timestamp: 1 }], model, 2048, undefined, undefined, controller.signal, undefined, undefined, undefined,
        (selected, context, options) => {
          const stream = streamAgyProvider(selected, context, options, bridge);
          streamResult = stream.result();
          return stream;
        });

      if (outcome === "success") assert.equal((await summarize()).text, "Concise summary");
      else if (outcome === "abort") { await summarize(); assert.equal(controller.signal.aborted, true); }
      else if (outcome === "delayed-abort") {
        const summary = summarize();
        await submitted;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(proc?.isRunning, true);
        assert.equal(disposed, 0);
        assert.ok(handler);
        controller.abort();
        await summary;
        const result = await streamResult;
        assert.equal(result?.stopReason, "aborted");
        assert.equal(controller.signal.aborted, true);
      }
      else if (outcome === "blocked-tool") await assert.rejects(summarize, /unavailable tool: read/);
      else await assert.rejects(summarize, outcome === "error" ? /backend rejected/ : /preparation rejected/);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(persist.mock.callCount(), 0);
      assert.equal(invalidate.mock.callCount(), 0);
      assert.equal(lookup.mock.callCount(), 0);
      assert.deepEqual(manager.getBranch(), normalBranch);
      assert.equal(prepared, 1);
      assert.equal(disposed, outcome === "preparation-error" ? 0 : 1);
      if (outcome === "delayed-abort") {
        assert.equal(proc?.isRunning, false);
        assert.equal(handler, undefined);
        assert.equal(disposed, 1);
      }
    });
  }
}

test("ModelRuntime pre-resolved compaction auth succeeds for enabled credentials", async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-compaction-auth-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const authPath = path.join(directory, "auth.json");
    await writeFile(authPath, JSON.stringify({
      agy: { type: "api_key", env: { AGY_BRIDGE_ENABLED: "1" } },
    }));
    const runtime = await ModelRuntime.create({ modelsPath: null, authPath, refreshOnCreate: false });
    let handler: ((event: RuntimeEvent) => void) | undefined;
    const driver: BridgeDriver = {
      id: "acp", label: "acp", sessionVersion: "test:v1",
      initialModels: [model],
      authentication: { label: "acp", probe: async () => true, login: async () => {} },
      validateSelection() {}, detectExecutable: () => "/bin/sh",
      discoverModels: async () => [model],
      usage: async () => undefined,
      async prepareSession(input) {
        const ipc = new BridgeIPC([], input.session.id, input.session.resources);
        const proc: DriverSession = {
          driver: "acp", isRunning: true,
          onRuntimeEvent(callback) { handler = callback; return () => { handler = undefined; }; },
          formatContextUpdate: () => "",
          abort: async () => {},
          async submit(submission) {
            assert.equal(submission.beforeInput(), true);
            handler?.({ type: "text-delta", delta: "Compacted through ModelRuntime" });
            handler?.({ type: "complete", reason: "stop", resumable: false });
          },
        };
        input.session.setSession(proc, "summary", ipc, "summary-conversation", input.preparationId);
        return { proc, mcpServer: ipc, reconstructContext: true, modelId: model.id };
      },
    };
    new Bridge({
      on: () => {}, registerCommand: () => {},
      getActiveTools: () => [], getAllTools: () => [],
      registerProvider: (registered: Provider) => runtime.registerNativeProvider(registered),
    } as unknown as ExtensionAPI, driver).start();
    await runtime.refresh({ providers: ["agy"], allowNetwork: false });
    const resolvedAuth = await runtime.getAuth(model);
    assert.ok(resolvedAuth);

    const result = await compact({
      firstKeptEntryId: "kept",
      messagesToSummarize: [{ role: "user", content: "Summarize me", timestamp: 1 }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 50,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
    }, model, resolvedAuth.auth.apiKey, undefined, undefined, undefined, undefined,
      (selected, context, options) => runtime.streamSimple(selected, context, options), resolvedAuth.env);

    assert.match(result.summary, /Compacted through ModelRuntime/);
  });
