import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultProviderAuthContext, type ApiKeyCredential } from "@earendil-works/pi-ai";
import { parseModelsOutput } from "../discovery/models.ts";
import { AgyAuthentication, createAgyBridgeCredential, isAgyBridgeEnabled } from "./auth.ts";
import { registerAgyProvider } from "./provider.ts";

const marker: ApiKeyCredential = { type: "api_key", env: { AGY_BRIDGE_ENABLED: "1" } };
const credentials = [
  { name: "enabled", credential: marker, enabled: true },
  { name: "missing", credential: undefined, enabled: false },
  { name: "wrong marker", credential: { type: "api_key", env: { AGY_BRIDGE_ENABLED: "0" } } satisfies ApiKeyCredential, enabled: false },
];

for (const status of ["unknown", "authenticated", "unauthenticated"] as const) {
  for (const scenario of credentials) {
    for (const aborted of [false, true]) {
      test(`availability check: ${status}, ${scenario.name}, aborted=${aborted}`, async (t) => {
        const authentication = new AgyAuthentication(undefined, async () => {});
        t.after(() => authentication.close());
        authentication.status = status;
        const spawn = t.mock.method(cp, "spawn", () => { throw new Error("Antigravity CLI authentication timed out"); });
        syncBuiltinESMExports();
        t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
        const controller = new AbortController();
        const reason = new Error("cancelled availability");
        if (aborted) controller.abort(reason);

        const check = authentication.method.check!({
          ctx: defaultProviderAuthContext(), signal: controller.signal,
          ...(scenario.credential ? { credential: scenario.credential } : {}),
        });
        if (aborted) await assert.rejects(Promise.resolve(check), (error) => error === reason);
        else assert.deepEqual(await check, scenario.enabled ? { type: "api_key", source: "Antigravity CLI CLI" } : undefined);

        const resolution = authentication.method.resolve({
          ctx: defaultProviderAuthContext(), signal: controller.signal,
          ...(scenario.credential ? { credential: scenario.credential } : {}),
        });
        if (aborted && scenario.enabled) await assert.rejects(Promise.resolve(resolution), (error) => error === reason);
        else assert.deepEqual(await resolution, scenario.enabled
          ? { auth: {}, env: { AGY_BRIDGE_ENABLED: "1" }, source: "Antigravity CLI CLI" }
          : undefined);

        assert.equal(spawn.mock.callCount(), 0);
        assert.equal(authentication.status, status);
      });
    }
  }
}

test("boot availability preserves stored scoped model selection without authentication probing", async (t) => {
  const { ModelRuntime, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const directory = await mkdtemp(path.join(os.tmpdir(), "agy-availability-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authPath = path.join(directory, "auth.json");
  const modelsPath = path.join(directory, "models.json");
  const ids = ["gemini-3.8-flash", "gemini-3.1-pro"];
  const scopedModels = ids.map((id) => `agy/${id}`);
  await writeFile(authPath, JSON.stringify({ agy: marker }));
  await writeFile(modelsPath, JSON.stringify({ providers: { agy: { modelOverrides: {
    "gemini-3.8-flash": { contextWindow: 123456 },
  } } } }));
  const runtime = await ModelRuntime.create({ modelsPath, authPath, refreshOnCreate: false });
  registerAgyProvider({
    on: () => {}, registerCommand: () => {},
    registerProvider: runtime.registerNativeProvider.bind(runtime),
  } as unknown as ExtensionAPI, {
    models: parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)\ngemini-3.1-pro-high  Gemini 3.1 Pro (High)"),
  });

  const refreshed = await runtime.refresh({ providers: ["agy"], allowNetwork: false });
  assert.equal(refreshed.errors.size, 0);
  assert.deepEqual(await runtime.checkAuth("agy"), { type: "api_key", source: "Antigravity CLI CLI" });
  const available = await runtime.getAvailable("agy");
  assert.deepEqual(available.map((model) => `${model.provider}/${model.id}`), scopedModels);
  for (const scoped of scopedModels) {
    const [provider, id] = scoped.split("/");
    assert.ok(runtime.getModel(provider!, id!));
  }
  assert.equal(runtime.getModel("agy", ids[0]!)?.contextWindow, 123456);

  const agentDir = path.join(directory, "agent");
  const settings = SettingsManager.create(directory, agentDir);
  settings.setEnabledModels(available.map((model) => `${model.provider}/${model.id}`));
  await settings.flush();
  assert.deepEqual(SettingsManager.create(directory, agentDir).getEnabledModels(), scopedModels);

  assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), { agy: marker });
  assert.deepEqual(await runtime.listCredentials(), [{ providerId: "agy", type: "api_key" }]);
});

test("request resolve rejects after bridge shutdown", async () => {
  const authentication = new AgyAuthentication(undefined, async () => {});
  authentication.close();
  await assert.rejects(Promise.resolve(authentication.method.resolve({
    ctx: defaultProviderAuthContext(), credential: marker, signal: new AbortController().signal,
  })), /Antigravity CLI bridge session has ended/);
});

for (const scenario of [
  { name: "legacy", credential: marker, enabled: true },
  { name: "OAuth", credential: createAgyBridgeCredential("availability"), enabled: true },
  { name: "unmarked OAuth", credential: { ...createAgyBridgeCredential(), agyBridge: false }, enabled: false },
]) {
  test(`bridge availability marker: ${scenario.name}`, () => {
    assert.equal(isAgyBridgeEnabled(scenario.credential), scenario.enabled);
  });
}
