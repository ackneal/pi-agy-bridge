import assert from "node:assert/strict";
import cp from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { ModelRegistry, ModelRuntime, type ExtensionAPI, type ExtensionContext, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { parseModelsOutput } from "../discovery/models.ts";
import { AgyAuthentication, createAgyBridgeCredential, getAgyBridgeAuthEnvironment } from "./auth.ts";
import { registerAgyProvider } from "./provider.ts";

for (const row of [
  { name: "automatically enables an existing AGY login", stored: "missing", authenticated: true, enabled: true },
  { name: "leaves an unauthenticated AGY unconfigured", stored: "missing", authenticated: false, enabled: false },
  { name: "uses existing OAuth without probing", stored: "oauth", authenticated: false, enabled: true },
  { name: "renews expired OAuth locally without probing", stored: "expired", authenticated: false, enabled: true },
  { name: "upgrades the legacy setup marker without probing", stored: "legacy", authenticated: false, enabled: true },
] as const) {
  test(`startup subscription: ${row.name}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-auto-subscription-"));
    const authPath = path.join(directory, "auth.json");
    const marker = createAgyBridgeCredential("existing-epoch");
    if (row.stored !== "missing") {
      await writeFile(authPath, JSON.stringify({ agy: row.stored === "legacy" ? {
        type: "api_key", env: { AGY_BRIDGE_ENABLED: "1", AGY_BRIDGE_LOGIN_EPOCH: "existing-epoch" },
      } : { ...marker, expires: row.stored === "expired" ? 0 : marker.expires } }));
    }
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
    const registry = new ModelRegistry(runtime);
    const detect = t.mock.method(AgyAuthentication.prototype, "detect", async () => row.authenticated ? marker : undefined);
    const spawn = t.mock.method(cp, "spawn", () => { throw new Error("Unexpected authentication subprocess"); });
    syncBuiltinESMExports();
    let sessionStart: ((event: SessionStartEvent, ctx: ExtensionContext) => void | Promise<void>) | undefined;
    let shutdown: (() => Promise<void>) | undefined;
    let refreshed!: () => void;
    let refreshFailed!: (reason: unknown) => void;
    const refreshFinished = new Promise<void>((resolve, reject) => { refreshed = resolve; refreshFailed = reject; });
    const refreshOperations: Promise<unknown>[] = [];
    const ctx = {
      sessionManager: { getSessionId: () => "auto-subscription-test" },
      modelRegistry: {
        refresh: async (options: Parameters<ModelRegistry["refresh"]>[0]) => {
          try {
            const operation = registry.refresh(options);
            refreshOperations.push(operation);
            const result = await operation;
            refreshed();
            return result;
          } catch (error) {
            refreshFailed(error);
            throw error;
          }
        },
      },
    } as unknown as ExtensionContext;
    t.after(async () => {
      await shutdown?.();
      await Promise.allSettled(refreshOperations);
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
    });
    const pi = {
      on: (event: string, handler: unknown) => {
        if (event === "session_start") sessionStart = handler as typeof sessionStart;
        if (event === "session_shutdown") shutdown = handler as typeof shutdown;
      },
      registerCommand: () => {}, getActiveTools: () => [], getAllTools: () => [],
      registerProvider: runtime.registerNativeProvider.bind(runtime),
    } as unknown as ExtensionAPI;
    const config = {
      authPath,
      models: parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)"),
    };
    registerAgyProvider(pi, config);
    assert.ok(sessionStart);
    assert.equal(sessionStart({ type: "session_start", reason: "startup" }, ctx), undefined);
    await refreshFinished;

    assert.equal(detect.mock.callCount(), row.stored === "missing" ? 1 : 0);
    assert.equal(runtime.isUsingSubscription("agy"), row.enabled);
    assert.equal(registry.getAvailable().length, row.enabled ? 1 : 0);
    assert.deepEqual(await runtime.listCredentials(), row.enabled ? [{ providerId: "agy", type: "oauth" }] : []);
    if (row.enabled) {
      const auth = await runtime.getAuth("agy");
      const saved = JSON.parse(await readFile(authPath, "utf8")).agy;
      assert.equal(saved.type, "oauth");
      assert.equal(saved.access, "");
      assert.equal(saved.refresh, "");
      assert.equal(saved.loginEpoch, "existing-epoch");
      assert.ok(saved.expires > Date.now() + 300000);
      assert.equal(getAgyBridgeAuthEnvironment(auth?.auth.apiKey)?.AGY_BRIDGE_LOGIN_EPOCH, "existing-epoch");
    }
    assert.equal(spawn.mock.callCount(), 0);

    await runtime.logout("agy");
    for (const reason of ["new", "reload", "startup"] as const) {
      sessionStart({ type: "session_start", reason }, ctx);
      await setImmediate();
    }
    assert.deepEqual(await runtime.listCredentials(), []);
    assert.equal(detect.mock.callCount(), row.stored === "missing" ? 1 : 0,
      "logout must not trigger automatic re-enablement in the current bridge instance");

    if (row.authenticated) {
      await Promise.allSettled(refreshOperations);
      await shutdown?.();
      const restartedRefresh = new Promise<void>((resolve, reject) => { refreshed = resolve; refreshFailed = reject; });
      registerAgyProvider(pi, config);
      sessionStart({ type: "session_start", reason: "startup" }, ctx);
      await restartedRefresh;
      assert.equal(detect.mock.callCount(), 2);
      assert.equal(runtime.isUsingSubscription("agy"), true);
      assert.equal(registry.getAvailable().length, 1);
    }
  });
}
