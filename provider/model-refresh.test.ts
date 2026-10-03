import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ModelsPublication, RefreshModelsContext } from "@earendil-works/pi-ai";
import { parseModelsOutput } from "../discovery/models.ts";
import { registerAgyProvider } from "./provider.ts";

for (const scenario of [
  { name: "cache-only restore", allowNetwork: false, accept: true, fail: false, aborted: false, expected: "claude-sonnet-4-6", publishes: 0 },
  { name: "successful discovery", allowNetwork: true, accept: true, fail: false, aborted: false, expected: "gemini-3.8-flash", publishes: 1 },
  { name: "rejected stale publication", allowNetwork: true, accept: false, fail: false, aborted: false, expected: "claude-sonnet-4-6", publishes: 1 },
  { name: "failed discovery retains cache", allowNetwork: true, accept: true, fail: true, aborted: false, expected: "claude-sonnet-4-6", publishes: 0 },
  { name: "aborted refresh skips work", allowNetwork: true, accept: true, fail: false, aborted: true, expected: undefined, publishes: 0 },
]) {
  test(`native AGY catalog: ${scenario.name}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-catalog-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const agyPath = path.join(directory, "agy");
    await writeFile(agyPath, scenario.fail
      ? "#!/bin/sh\nexit 7\n"
      : '#!/bin/sh\nprintf "gemini-3.8-flash-high  Gemini 3.8 Flash (High)\\n"\n', { mode: 0o755 });
    let refresh: ((context: RefreshModelsContext) => Promise<ProviderModelConfig[]>) | undefined;
    const pi = {
      on: () => {}, registerCommand: () => {},
      registerProvider: (_id: string, config: { refreshModels?: typeof refresh }) => { refresh = config.refreshModels; },
    } as unknown as ExtensionAPI;
    registerAgyProvider(pi, { agyPath });
    assert.ok(refresh);
    const publications: ModelsPublication[] = [];
    const controller = new AbortController();
    if (scenario.aborted) controller.abort();
    const restored = parseModelsOutput("claude-sonnet-4-6  Claude Sonnet 4.6 (Thinking)");

    const models = await refresh({
      stored: { models: restored }, allowNetwork: scenario.allowNetwork, signal: controller.signal,
      publish: async (publication) => {
        if (publication.persist) publications.push(publication);
        const accepted = !publication.persist || scenario.accept;
        if (accepted) publication.update?.();
        return accepted;
      }
    });

    assert.equal(models[0]?.id, scenario.expected);
    assert.equal(publications.length, scenario.publishes);
    if (scenario.publishes) {
      const persisted = publications[0]?.persist?.models[0];
      assert.equal(persisted?.provider, "agy");
      assert.equal(persisted?.api, "agy");
      assert.equal(persisted?.baseUrl, "agy");
      assert.equal(persisted?.id, "gemini-3.8-flash");
      assert.ok(persisted && "maxTokens" in persisted);
      assert.equal(persisted.maxTokens, 65536);
      assert.deepEqual(persisted?.cost, { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 });
    }
  });
}

test("Pi persists raw AGY discovery and reapplies models.json overrides after restore", async (t) => {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const directory = await mkdtemp(path.join(os.tmpdir(), "agy-native-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modelsPath = path.join(directory, "models.json");
  const agyPath = path.join(directory, "agy");
  await writeFile(modelsPath, JSON.stringify({ providers: { agy: {
    modelOverrides: { "gemini-3.8-flash": { contextWindow: 123456, maxTokens: 4321, cost: { input: 9, output: 10, cacheRead: 2, cacheWrite: 3 } } },
  } } }));
  await writeFile(agyPath, '#!/bin/sh\nprintf "gemini-3.8-flash-high  Gemini 3.8 Flash (High)\\ngemini-3.1-pro-high  Gemini 3.1 Pro (High)\\n"\n', { mode: 0o755 });
  const runtime = await ModelRuntime.create({ modelsPath, authPath: path.join(directory, "auth.json"), refreshOnCreate: false });
  const pi = {
    on: () => {}, registerCommand: () => {},
    registerProvider: runtime.registerProvider.bind(runtime),
  } as unknown as ExtensionAPI;
  registerAgyProvider(pi, { agyPath });

  await runtime.refresh({ providers: ["agy"], allowNetwork: false });

  const result = await runtime.refresh({ providers: ["agy"], allowNetwork: true });

  assert.equal(result.aborted, false);
  assert.equal(result.errors.size, 0);
  assert.equal(runtime.getModel("agy", "gemini-3.8-flash")?.contextWindow, 123456);
  assert.equal(runtime.getModel("agy", "gemini-3.8-flash")?.maxTokens, 4321);
  assert.deepEqual(runtime.getModel("agy", "gemini-3.8-flash")?.cost, { input: 9, output: 10, cacheRead: 2, cacheWrite: 3, tiers: undefined });
  const stored = JSON.parse(await readFile(path.join(directory, "models-store.json"), "utf8"));
  assert.equal(stored.agy.models[0].contextWindow, 1048576);
  assert.equal(stored.agy.models[0].maxTokens, 65536);
  assert.deepEqual(stored.agy.models[0].cost, { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 });
  const proCost = {
    input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0,
    tiers: [{ inputTokensAbove: 200000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 0 }],
  };
  assert.deepEqual(stored.agy.models[1].cost, proCost);

  const next = await ModelRuntime.create({ modelsPath, authPath: path.join(directory, "auth.json"), refreshOnCreate: false });
  registerAgyProvider({ ...pi, registerProvider: next.registerProvider.bind(next) } as unknown as ExtensionAPI,
    { agyPath: "__invalid_binary_name__" });
  const restored = await next.refresh({ providers: ["agy"], allowNetwork: false });
  assert.equal(restored.errors.size, 0);
  assert.equal(next.getModel("agy", "gemini-3.8-flash")?.contextWindow, 123456);
  assert.equal(next.getModel("agy", "gemini-3.8-flash")?.maxTokens, 4321);
  assert.deepEqual(next.getModel("agy", "gemini-3.1-pro")?.cost, proCost);
  assert.deepEqual(next.getModel("agy", "gemini-3.8-flash")?.cost, { input: 9, output: 10, cacheRead: 2, cacheWrite: 3, tiers: undefined });
});
