import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { AgyAuthentication, createAgyBridgeCredential } from "./auth.ts";
import { AgyBridge } from "./provider.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

for (const scenario of [
  { name: "configured startup refreshes models without probing", configured: true, reason: "startup", registryFails: false, shutdown: false },
  { name: "pending detection does not delay startup", configured: false, reason: "startup", registryFails: false, shutdown: false },
  { name: "model refresh failure is caught", configured: true, reason: "startup", registryFails: true, shutdown: false },
  { name: "shutdown during detection skips stale model refresh", configured: false, reason: "startup", registryFails: false, shutdown: true },
  { name: "reload does not automatically reopen a logged-out bridge", configured: false, reason: "reload", registryFails: false, shutdown: false },
] as const) {
  test(`session startup: ${scenario.name}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-startup-"));
    const authPath = path.join(directory, "auth.json");
    if (scenario.configured) await writeFile(authPath, JSON.stringify({ agy: createAgyBridgeCredential() }));
    const detection = deferred<OAuthCredential | undefined>();
    const discovery = deferred<void>();
    const detect = t.mock.method(AgyAuthentication.prototype, "detect", () => detection.promise);
    const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("Unexpected AGY subprocess"); });
    syncBuiltinESMExports();
    let sessionStart: ((event: SessionStartEvent, ctx: ExtensionContext) => void | Promise<void>) | undefined;
    let shutdown: (() => Promise<void>) | undefined;
    const pi = {
      on: (event: string, handler: unknown) => {
        if (event === "session_start") sessionStart = handler as typeof sessionStart;
        if (event === "session_shutdown") shutdown = handler as typeof shutdown;
      },
      registerCommand: () => {}, registerProvider: () => {},
    } as unknown as ExtensionAPI;
    const bridge = new AgyBridge(pi, { authPath });
    const dispose = t.mock.method(bridge.liveSessions, "disposeAll", async () => {});
    const sessionManager = { getSessionId: t.mock.fn(() => "startup-test") };
    const refreshModels = t.mock.fn(() => discovery.promise);
    const ctx = { sessionManager, modelRegistry: { refresh: refreshModels } } as unknown as ExtensionContext;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    t.after(async () => {
      detection.resolve(undefined);
      discovery.resolve();
      await shutdown?.();
      await setImmediate();
      process.off("unhandledRejection", onUnhandled);
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
    });
    bridge.start();
    assert.ok(sessionStart);
    assert.ok(shutdown);

    const result = sessionStart({ type: "session_start", reason: scenario.reason }, ctx);
    assert.equal(result, undefined);
    assert.equal(bridge.piContextAdapter.getSessionManager("startup-test"), sessionManager);
    await setImmediate();
    const shouldDetect = !scenario.configured && scenario.reason === "startup";
    assert.equal(detect.mock.callCount(), shouldDetect ? 1 : 0);
    assert.equal(refreshModels.mock.callCount(), shouldDetect ? 0 : 1);

    if (scenario.shutdown) {
      await shutdown();
      assert.equal(dispose.mock.callCount(), 1);
    }
    detection.resolve(undefined);
    await setImmediate();
    assert.equal(refreshModels.mock.callCount(), scenario.shutdown ? 0 : 1);
    if (!scenario.shutdown) {
      assert.deepEqual(refreshModels.mock.calls[0]?.arguments, [{ providers: ["agy"], allowNetwork: true }]);
    }

    if (scenario.registryFails) discovery.reject(new Error("model refresh failed"));
    else discovery.resolve();
    await setImmediate();
    assert.equal(spawn.mock.callCount(), 0);
    assert.deepEqual(unhandled, []);
  });
}
