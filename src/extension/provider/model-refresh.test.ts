import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelsPublication, Provider } from "@earendil-works/pi-ai";
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
      ? '#!/bin/sh\nexit 7\n'
      : '#!/bin/sh\ncase " $* " in *" --input-format "*) printf \'{"event":"init"}\\n\'; while :; do sleep 1; done;; esac\nprintf "gemini-3.8-flash-high  Gemini 3.8 Flash (High)\\n"\n', { mode: 0o755 });
    let provider: Provider | undefined;
    const pi = {
      on: () => {}, registerCommand: () => {},
      registerProvider: (registered: Provider) => { provider = registered; },
    } as unknown as ExtensionAPI;
    registerAgyProvider(pi, { agyPath });
    assert.ok(provider?.refreshModels);
    const publications: ModelsPublication[] = [];
    const controller = new AbortController();
    if (scenario.aborted) controller.abort();
    const restored = parseModelsOutput("claude-sonnet-4-6  Claude Sonnet 4.6 (Thinking)");

    const result = await provider.refreshModels({
      stored: { models: restored }, allowNetwork: scenario.allowNetwork, signal: controller.signal,
      publish: async (publication) => {
        if (publication.persist) publications.push(publication);
        const accepted = !publication.persist || scenario.accept;
        if (accepted) publication.update?.();
        return accepted;
      }
    });

    assert.equal(result, undefined);
    assert.equal(provider.getModels()[0]?.id, scenario.expected);
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

async function registerAndAwaitRefresh(t: TestContext, runtime: ModelRuntime, register: () => void): Promise<void> {
  const refresh = runtime.refresh.bind(runtime);
  let registrationRefresh: ReturnType<ModelRuntime["refresh"]> | undefined;
  const mockedRefresh = t.mock.method(runtime, "refresh", (...args: Parameters<ModelRuntime["refresh"]>) => {
    registrationRefresh = refresh(...args);
    return registrationRefresh;
  });
  try {
    register();
    assert.ok(registrationRefresh, "provider registration must start an offline refresh");
    await registrationRefresh;
  } finally {
    mockedRefresh.mock.restore();
  }
}

test("Pi persists raw AGY discovery and reapplies models.json overrides after restore", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agy-native-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modelsPath = path.join(directory, "models.json");
  const agyPath = path.join(directory, "agy");
  await writeFile(modelsPath, JSON.stringify({ providers: { agy: {
    modelOverrides: { "gemini-3.8-flash": { contextWindow: 123456, maxTokens: 4321, cost: { input: 9, output: 10, cacheRead: 2, cacheWrite: 3 } } },
  } } }));
  await writeFile(agyPath, '#!/bin/sh\ncase " $* " in *" --input-format "*) printf \'{"event":"init"}\\n\'; while :; do sleep 1; done;; esac\nprintf "gemini-3.8-flash-high  Gemini 3.8 Flash (High)\\ngemini-3.1-pro-high  Gemini 3.1 Pro (High)\\n"\n', { mode: 0o755 });
  const authPath = path.join(directory, "auth.json");
  await writeFile(authPath, JSON.stringify({ agy: { type: "api_key", env: { AGY_BRIDGE_ENABLED: "1" } } }));
  const runtime = await ModelRuntime.create({ modelsPath, authPath, refreshOnCreate: false });
  let sessionStart: ((event: unknown, ctx: unknown) => void | Promise<void>) | undefined;
  const pi = {
    on: (event: string, handler: typeof sessionStart) => { if (event === "session_start") sessionStart = handler; }, registerCommand: () => {},
    registerProvider: runtime.registerNativeProvider.bind(runtime),
  } as unknown as ExtensionAPI;
  await registerAndAwaitRefresh(t, runtime, () => registerAgyProvider(pi, { agyPath }));

  await runtime.refresh({ providers: ["agy"], allowNetwork: false });

  let resolveRefresh!: (result: Awaited<ReturnType<typeof runtime.refresh>>) => void;
  let rejectRefresh!: (error: unknown) => void;
  const backgroundRefreshFinished = new Promise<Awaited<ReturnType<typeof runtime.refresh>>>((resolve, reject) => {
    resolveRefresh = resolve;
    rejectRefresh = reject;
  });

  assert.ok(sessionStart);
  await sessionStart({}, {
    sessionManager: { getSessionId: () => "native-catalog-test" },
    modelRegistry: {
      refresh: (...args: Parameters<typeof runtime.refresh>) => {
        const refresh = runtime.refresh(...args);
        void refresh.then(resolveRefresh, rejectRefresh);
        return refresh;
      },
    },
  });
  const result = await backgroundRefreshFinished;

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
  await registerAndAwaitRefresh(t, next, () => registerAgyProvider(
    { ...pi, registerProvider: next.registerNativeProvider.bind(next) } as unknown as ExtensionAPI,
    { agyPath: "__invalid_binary_name__" },
  ));
  const restored = await next.refresh({ providers: ["agy"], allowNetwork: false });
  assert.equal(restored.errors.size, 0);
  assert.equal(next.getModel("agy", "gemini-3.8-flash")?.contextWindow, 123456);
  assert.equal(next.getModel("agy", "gemini-3.8-flash")?.maxTokens, 4321);
  assert.deepEqual(next.getModel("agy", "gemini-3.1-pro")?.cost, proCost);
  assert.deepEqual(next.getModel("agy", "gemini-3.8-flash")?.cost, { input: 9, output: 10, cacheRead: 2, cacheWrite: 3, tiers: undefined });
});
