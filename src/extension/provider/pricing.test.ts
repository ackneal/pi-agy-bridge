import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateSummaryWithUsage, ModelRuntime, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { BridgeIPC } from "../bridge/ipc.ts";
import { parseModelsOutput } from "../discovery/models.ts";
import { SessionMode, type BridgeDriver, type DriverSession, type RuntimeEvent } from "../drivers/types.ts";
import { Bridge, streamProvider } from "./provider.ts";

function usage(input: number, output: number, cacheRead: number, cacheWrite: number): Usage {
  return {
    input, output, cacheRead, cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function expectedCost(tokens: Usage, rates: { input: number; output: number; cacheRead: number; cacheWrite: number }): Usage["cost"] {
  const input = tokens.input * rates.input / 1_000_000;
  const output = tokens.output * rates.output / 1_000_000;
  const cacheRead = tokens.cacheRead * rates.cacheRead / 1_000_000;
  const cacheWrite = tokens.cacheWrite * rates.cacheWrite / 1_000_000;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function assertCost(actual: Usage["cost"], expected: Usage["cost"]): void {
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    assert.ok(Math.abs(actual[field] - expected[field]) < 1e-12, `${field}: expected ${expected[field]}, got ${actual[field]}`);
  }
}

for (const id of ["cli", "acp"] as const) {
  for (const pricing of ["built-in", "models.json override"] as const) {
    for (const scenario of ["conversation split", "conversation context-only", "standalone summary"] as const) {
      test(`${id}: ${scenario} uses ${pricing} prices from the passed Pi model`, { timeout: 5_000 }, async (t) => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "agy-pricing-"));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const modelsPath = path.join(directory, "models.json");
        const override = { input: 9, output: 10, cacheRead: 2, cacheWrite: 3 };
        const catalog = parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)");
        const builtin = catalog[0]!;
        await writeFile(modelsPath, JSON.stringify({ providers: { agy: {
          modelOverrides: pricing === "models.json override" ? { [builtin.id]: { cost: override } } : {},
        } } }));
        const runtime = await ModelRuntime.create({ modelsPath, authPath: path.join(directory, "auth.json"), refreshOnCreate: false });
        const total = usage(1_000, 200, 300, 40);
        const last = usage(400, 80, 100, 10);
        const contextUsage = { ...usage(0, 0, 0, 0), totalTokens: last.totalTokens };
        const remainder = usage(600, 120, 200, 30);
        const standalone = scenario === "standalone summary";
        let handler: ((event: RuntimeEvent) => void) | undefined;
        let prepared = 0;
        let submitted = 0;
        const driver: BridgeDriver = {
          id, label: id, sessionVersion: "pricing:v1", initialModels: catalog,
          authentication: { label: id, probe: async () => false, login: async () => {} },
          validateSelection() {}, detectExecutable: () => undefined,
          discoverModels: async () => { assert.fail("Pricing tests must not discover models"); },
          usage: async () => undefined,
          async prepareSession(input) {
            prepared++;
            assert.equal(input.model, effective);
            assert.equal(input.mode, standalone ? SessionMode.Standalone : SessionMode.Conversation);
            assert.deepEqual(input.tools, []);
            const ipc = new BridgeIPC([], input.session.id, input.session.resources);
            let running = true;
            const proc: DriverSession = {
              driver: id, get isRunning() { return running; },
              onRuntimeEvent(callback) { handler = callback; return () => { handler = undefined; }; },
              serializeContextUpdate: () => "",
              abort: async () => { running = false; },
              async submit(submission) {
                submitted++;
                assert.equal(submission.model, effective);
                assert.equal(submission.beforeInput(), true);
                handler?.({ type: "text-delta", delta: "Concise summary" });
                // Context snapshots are not billable. Accounting arrives separately.
                handler?.({ type: "usage", usage: contextUsage });
                if (scenario === "conversation context-only") {
                  handler?.({ type: "accounting", usage: total });
                } else {
                  handler?.({ type: "accounting", usage: total, lastCallUsage: last });
                }
                handler?.({ type: "complete", reason: "stop", resumable: false });
              },
            };
            input.session.setSession(proc, "pricing", ipc, "pricing-conversation", input.preparationId);
            // A backend-selected display ID must not replace the effective pricing model.
            return { proc, mcpServer: ipc, reconstructContext: true, modelId: "backend-selected-model" };
          },
        };
        let shutdown: (() => Promise<void>) | undefined;
        const bridge = new Bridge({
          on: (event: string, callback: () => Promise<void>) => { if (event === "session_shutdown") shutdown = callback; },
          registerCommand: () => {}, getActiveTools: () => [], getAllTools: () => [],
          registerProvider: runtime.registerNativeProvider.bind(runtime),
        } as unknown as ExtensionAPI, driver);
        t.after(async () => { await shutdown?.(); });
        const refresh = runtime.refresh.bind(runtime);
        let registrationRefresh: ReturnType<ModelRuntime["refresh"]> | undefined;
        const refreshMock = t.mock.method(runtime, "refresh", (...args: Parameters<ModelRuntime["refresh"]>) => {
          registrationRefresh = refresh(...args);
          return registrationRefresh;
        });
        bridge.start();
        assert.ok(registrationRefresh);
        await registrationRefresh;
        refreshMock.mock.restore();
        const refreshed = await runtime.refresh({ providers: ["agy"], allowNetwork: false });
        assert.equal(refreshed.errors.size, 0);
        const effective = runtime.getModel("agy", builtin.id);
        assert.ok(effective);
        const rates = pricing === "models.json override" ? override : builtin.cost;
        for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
          assert.equal(effective.cost[field], rates[field]);
        }
        if (pricing === "models.json override") assert.notDeepEqual(effective.cost, builtin.cost);

        const manager = SessionManager.inMemory();
        const sessionId = bridge.piContextAdapter.bind(manager);
        let message: AssistantMessage;
        if (standalone) {
          let result: Promise<AssistantMessage> | undefined;
          const summary = await generateSummaryWithUsage([
            { role: "user", content: "Original conversation detail", timestamp: 1 },
          ], effective, 2048, undefined, undefined, undefined, undefined, undefined, undefined,
          (model, context, options) => {
            const stream = streamProvider(model, context, options, bridge);
            result = stream.result();
            return stream;
          });
          assert.equal(summary.text, "Concise summary");
          assert.ok(result);
          message = await result;
          assert.deepEqual(summary.usage, message.usage);
        } else {
          message = await streamProvider(effective, {
            messages: [{ role: "user", content: "Original conversation detail", timestamp: 1 }], tools: [],
          }, { sessionId }, bridge).result();
        }

        assert.equal(prepared, 1);
        assert.equal(submitted, 1);
        assert.equal(message.stopReason, "stop", message.errorMessage ?? "request must succeed");
        assert.equal(message.model, "backend-selected-model");
        const accounting = manager.getBranch().filter((entry) => entry.type === "usage");
        const assistantTokens = standalone ? total : scenario === "conversation context-only" ? contextUsage : last;
        assert.equal(message.usage.totalTokens, assistantTokens.totalTokens);
        if (scenario === "conversation context-only") {
          assert.deepEqual(message.usage.cost, usage(0, 0, 0, 0).cost);
        } else {
          assertCost(message.usage.cost, expectedCost(assistantTokens, rates));
        }
        assert.equal(accounting.length, standalone ? 0 : 1);
        if (!standalone) {
          const entry = accounting[0]!;
          assert.equal(entry.kind, "agy_turn");
          assert.equal(entry.provider, "agy");
          assert.equal(entry.model, "backend-selected-model");
          const accountedTokens = scenario === "conversation split" ? remainder : total;
          assert.equal(entry.usage.totalTokens, accountedTokens.totalTokens);
          assertCost(entry.usage.cost, expectedCost(accountedTokens, rates));
        }
        for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
          const recorded = message.usage[field] + accounting.reduce((sum, entry) => sum + entry.usage[field], 0);
          assert.equal(recorded, total[field], `${field} must be counted exactly once`);
        }
        const fee = message.usage.cost.total + accounting.reduce((sum, entry) => sum + entry.usage.cost.total, 0);
        assert.ok(Math.abs(fee - expectedCost(total, rates).total) < 1e-12, "assistant plus separate accounting must charge exactly the prompt fee");
        if (pricing === "models.json override") {
          assert.ok(Math.abs(fee - expectedCost(total, builtin.cost).total) > 1e-6, "user overrides must beat built-in prices");
        }
      });
    }
  }
}
