import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { Credential, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, readStoredCredential, type ExtensionAPI, type ExtensionContext, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { Driver as AcpDriver } from "../drivers/acp/driver.ts";
import { Driver as CliDriver } from "../drivers/cli/driver.ts";
import type { DriverAuthentication } from "../drivers/types.ts";
import { parseModelsOutput } from "../discovery/models.ts";
import { AgyAuthentication, createAgyBridgeCredential } from "./auth.ts";
import { registerAuthHomeFixture } from "./auth-home-fixture.ts";
import { Bridge } from "./provider.ts";
import { autoConfigureAgyAuthentication } from "./startup-auth.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const noProbeBackend: DriverAuthentication = {
  label: "Antigravity CLI",
  probe: async () => { throw new Error("Unexpected authentication probe"); },
  login: async () => { throw new Error("Unexpected authentication login"); },
};

const noRequests = {
  stream: () => { throw new Error("network forbidden"); },
  streamSimple: () => { throw new Error("network forbidden"); },
};

const existing = createAgyBridgeCredential();
const legacy: Credential = { type: "api_key", env: { AGY_BRIDGE_ENABLED: "1", AGY_BRIDGE_LOGIN_EPOCH: "legacy-epoch" } };
const other: Credential = { type: "api_key", key: "other" };

for (const scenario of [
  { name: "configured startup probes before refreshing models", configured: true, reason: "startup", registryFails: false, shutdown: false },
  { name: "pending detection does not delay startup", configured: false, reason: "startup", registryFails: false, shutdown: false },
  { name: "model refresh failure is caught", configured: true, reason: "startup", registryFails: true, shutdown: false },
  { name: "shutdown during detection skips stale model refresh", configured: false, reason: "startup", registryFails: false, shutdown: true },
  { name: "reload does not automatically reopen a logged-out bridge", configured: false, reason: "reload", registryFails: false, shutdown: false },
] as const) {
  test(`session startup: ${scenario.name}`, async (t) => {
    const directory = await registerAuthHomeFixture(t);
    const authPath = path.join(directory, "auth.json");
    if (scenario.configured) await writeFile(authPath, JSON.stringify({ agy: createAgyBridgeCredential() }));
    const detection = deferred<OAuthCredential | undefined>();
    const discovery = deferred<void>();
    const detect = t.mock.method(AgyAuthentication.prototype, "detect", () => detection.promise);
    const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("Unexpected Antigravity CLI subprocess"); });
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
    const bridge = new Bridge(pi, new CliDriver());
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
      spawn.mock.restore();
      detect.mock.restore();
      dispose.mock.restore();
      syncBuiltinESMExports();
    });
    bridge.start();
    assert.ok(sessionStart);
    assert.ok(shutdown);

    const result = sessionStart({ type: "session_start", reason: scenario.reason }, ctx);
    assert.equal(result, undefined);
    assert.equal(bridge.piContextAdapter.getSessionManager("startup-test"), sessionManager);
    await setImmediate();
    const shouldDetect = scenario.reason === "startup";
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
    await shutdown?.();
    assert.equal(spawn.mock.callCount(), 0);
    assert.deepEqual(unhandled, []);
  });
}

for (const scenario of [
  { name: "persists detection", probes: 1, saved: true },
  { name: "unsuccessful detection does not save", probes: 1, false: true },
  { name: "error propagates without saving", probes: 1, error: true },
  { name: "existing marker skips detection unchanged", initial: existing, probes: 0 },
  { name: "user credential skips detection and remains untouched", initial: other, probes: 0 },
  { name: "legacy marker is converted without detection", initial: legacy, probes: 0 },
  { name: "changed credential wins", probes: 1, changed: true },
  { name: "abort prevents persistence", probes: 1, abort: true },
  { name: "shutdown prevents persistence", probes: 1, close: true },
]) {
  test(`startup auth configuration: ${scenario.name}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-startup-configuration-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const authPath = path.join(directory, "auth.json");
    const controller = new AbortController();
    const authentication = new AgyAuthentication(noProbeBackend, async () => { throw new Error("real login forbidden"); });
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
    const models = parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)");
    runtime.registerNativeProvider({ ...noRequests, id: "agy", name: "Antigravity CLI", getModels: () => models, auth: { oauth: authentication.oauth } });
    const registry = new ModelRegistry(runtime);
    const interaction = { signal: controller.signal, notify: () => {}, prompt: async () => { throw new Error("prompt forbidden"); } };
    const store = async (credential: Credential) => {
      const writer = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
      writer.registerNativeProvider({ ...noRequests, id: "agy", name: "Antigravity CLI", getModels: () => [], auth: {
        ...(credential.type === "oauth"
          ? { oauth: { ...authentication.oauth, login: async () => credential } }
          : { apiKey: { name: "test", login: async () => credential, resolve: async () => undefined } }),
      } });
      await writer.login("agy", credential.type, interaction);
    };
    if (scenario.initial) await store(scenario.initial);
    await registry.refresh({ providers: ["agy"], allowNetwork: false });
    if (!scenario.initial) assert.equal(registry.getAvailable().length, 0);
    const detected = createAgyBridgeCredential();
    const probe = t.mock.method(authentication, "detect", async () => {
      if (scenario.changed) await store(other);
      if (scenario.abort) controller.abort(new Error("cancelled"));
      if (scenario.close) authentication.close();
      if (scenario.error) throw new Error("probe failed");
      return scenario.false ? undefined : detected;
    });

    const operation = autoConfigureAgyAuthentication(authentication, authPath, controller.signal);
    if (scenario.error || scenario.abort || scenario.close) await assert.rejects(operation);
    else await operation;

    assert.equal(probe.mock.callCount(), scenario.probes);
    const stored = readStoredCredential("agy", authPath);
    if (scenario.saved) {
      assert.equal(stored?.type, "oauth");
      assert.equal(stored?.loginEpoch, undefined);
      await registry.refresh({ providers: ["agy"], allowNetwork: false });
      assert.equal(registry.getAvailable().length, 1);
      assert.equal(registry.isUsingOAuth(models[0]!), true);
      assert.equal((await runtime.checkAuth("agy"))?.type, "oauth");
    } else if (scenario.name === "legacy marker is converted without detection") {
      assert.equal(stored?.type, "oauth");
      assert.equal(stored?.loginEpoch, undefined);
    } else {
      assert.deepEqual(stored, scenario.changed ? other : scenario.initial);
    }
  });
}

for (const row of [
  { name: "new credential", initial: undefined, newer: other },
  { name: "logout of legacy marker", initial: legacy, newer: undefined },
]) {
  test(`Pi 1.0.0 commit-window limitation: overwrites ${row.name}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-commit-race-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const authPath = path.join(directory, "auth.json");
    const credentials = new InMemoryCredentialStore();
    if (row.initial) await credentials.modify("agy", async () => row.initial);
    await writeFile(authPath, JSON.stringify(row.initial ? { agy: row.initial } : {}));
    const authentication = new AgyAuthentication(noProbeBackend, async () => { throw new Error("login forbidden"); });
    t.after(() => authentication.close());
    t.mock.method(authentication, "detect", async () => createAgyBridgeCredential());
    const create = ModelRuntime.create.bind(ModelRuntime);
    t.mock.method(ModelRuntime, "create", (options: Parameters<typeof ModelRuntime.create>[0]) => create({ ...options, credentials }));
    const modify = credentials.modify.bind(credentials);
    let commits = 0;
    t.mock.method(credentials, "modify", async (providerId: string, fn: Parameters<typeof credentials.modify>[1], options: Parameters<typeof credentials.modify>[2]) => {
      commits++;
      if (row.newer) await modify(providerId, async () => row.newer);
      else await credentials.delete(providerId);
      await writeFile(authPath, JSON.stringify(row.newer ? { agy: row.newer } : {}));
      const result = await modify(providerId, async (current) => {
        assert.deepEqual(current, row.newer);
        return fn(current);
      }, options);
      await writeFile(authPath, JSON.stringify({ agy: result }));
      return result;
    });

    await autoConfigureAgyAuthentication(authentication, authPath, new AbortController().signal);

    assert.equal(commits, 1);
    const stored = readStoredCredential("agy", authPath);
    assert.equal(stored?.type, "oauth");
    assert.ok(stored?.type === "oauth");
    assert.equal(stored.loginEpoch, undefined);
  });
}

for (const driverId of ["cli", "acp"] as const) {
  test(`saved ${driverId} is restored before registration and survives authenticated startup`, async (t) => {
    const directory = await registerAuthHomeFixture(t);
    const authPath = path.join(directory, "auth.json");
    const original = { ...createAgyBridgeCredential(driverId), expires: 4102444800000 };
    await writeFile(authPath, JSON.stringify({ agy: original }));
    const events: string[] = [];
    const models = parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)")
      .map((model) => ({ ...model, agyDriver: driverId }));
    const discoveries = [CliDriver, AcpDriver].map((Driver) => t.mock.method(Driver.prototype, "discoverModels", async function (this: CliDriver | AcpDriver) {
      assert.equal(this.id, driverId);
      events.push(`discover:${this.id}`);
      return models;
    }));
    let provider!: Provider;
    let start!: (event: SessionStartEvent, context: ExtensionContext) => void;
    let shutdown!: () => Promise<void>;
    const bridge = new Bridge({
      on: (event: string, handler: unknown) => {
        if (event === "session_start") start = handler as typeof start;
        if (event === "session_shutdown") shutdown = handler as typeof shutdown;
      },
      registerCommand() {},
      registerProvider: (registered: Provider) => {
        assert.equal(bridge.driver.id, driverId);
        events.push(`register:${bridge.driver.id}`);
        provider = registered;
      },
    } as unknown as ExtensionAPI);
    const authenticated = deferred<boolean>();
    const probe = t.mock.method(bridge.driver.authentication, "probe", () => {
      assert.equal(bridge.driver.id, driverId);
      events.push(`probe:${bridge.driver.id}`);
      return authenticated.promise;
    });
    const login = t.mock.method(bridge.driver.authentication, "login", async () => { throw new Error("Unexpected login"); });
    const piLogin = t.mock.method(ModelRuntime.prototype, "login");
    const piLogout = t.mock.method(ModelRuntime.prototype, "logout");
    const completed = deferred<void>();
    const refresh = t.mock.fn(async (options: unknown) => {
      try {
        assert.deepEqual(options, { providers: ["agy"], allowNetwork: true });
        assert.deepEqual(readStoredCredential("agy", authPath), original);
        await provider.refreshModels!({
          allowNetwork: true, signal: new AbortController().signal,
          publish: async (publication) => { publication.update?.(); return true; },
        });
        completed.resolve();
      } catch (error) {
        completed.reject(error);
      }
    });
    t.after(async () => {
      authenticated.resolve(true);
      await shutdown?.();
    });

    assert.equal(bridge.driver.id, driverId);
    assert.deepEqual(events, []);
    bridge.start();
    assert.deepEqual(events, [`register:${driverId}`]);
    assert.equal(start({ type: "session_start", reason: "startup" }, {
      hasUI: false, sessionManager: { getSessionId: () => "restored-driver" }, modelRegistry: { refresh },
    } as unknown as ExtensionContext), undefined);
    assert.deepEqual(events, [`register:${driverId}`, `probe:${driverId}`]);
    assert.equal(refresh.mock.callCount(), 0);
    authenticated.resolve(true);
    await completed.promise;

    assert.deepEqual(events, [`register:${driverId}`, `probe:${driverId}`, `discover:${driverId}`]);
    assert.equal(probe.mock.callCount(), 1);
    assert.equal(login.mock.callCount(), 0);
    assert.equal(piLogin.mock.callCount(), 0);
    assert.equal(piLogout.mock.callCount(), 0);
    assert.equal(refresh.mock.callCount(), 1);
    assert.equal(discoveries[0]!.mock.callCount(), driverId === "cli" ? 1 : 0);
    assert.equal(discoveries[1]!.mock.callCount(), driverId === "acp" ? 1 : 0);
    assert.equal(bridge.driver.id, driverId);
    assert.equal(provider.getModels()[0]?.id, models[0]!.id);
    assert.deepEqual(readStoredCredential("agy", authPath), original);
  });
}

for (const driverId of ["cli", "acp"] as const) {
  for (const outcome of ["success", "required", "error"] as const) {
    for (const saved of ["absent", "matching", "other driver"] as const) {
      test(`${driverId} startup ${outcome} with ${saved} credential`, async (t) => {
        const directory = await registerAuthHomeFixture(t);
        const authPath = path.join(directory, "auth.json");
        const original = saved === "absent" ? undefined : { ...createAgyBridgeCredential(), driver: saved === "matching" ? driverId : driverId === "cli" ? "acp" : "cli" };
        if (original) await writeFile(authPath, JSON.stringify({ agy: original }));
        let start!: (event: SessionStartEvent, context: ExtensionContext) => void;
        let shutdown!: () => Promise<void>;
        const driver = driverId === "cli" ? new CliDriver() : new AcpDriver();
        const probe = t.mock.method(driver.authentication, "probe", async () => {
          if (outcome === "error") throw new Error("fixture connection failure");
          return outcome === "success";
        });
        const login = t.mock.method(driver.authentication, "login", async () => { throw new Error("must not log in"); });
        const sendMessage = t.mock.fn();
        const notify = t.mock.fn();
        const setStatus = t.mock.fn();
        const pi = {
          on: (event: string, handler: unknown) => {
            if (event === "session_start") start = handler as typeof start;
            if (event === "session_shutdown") shutdown = handler as typeof shutdown;
          },
          registerCommand: () => {}, registerProvider: () => {}, sendMessage,
        } as unknown as ExtensionAPI;
        const bridge = new Bridge(pi, driver);
        let refreshed!: () => void;
        const completed = new Promise<void>((resolve) => { refreshed = resolve; });
        const refresh = t.mock.fn(async () => { refreshed(); });
        const hasUI = saved === "matching";
        const context = { hasUI, ui: { notify, setStatus }, sessionManager: { getSessionId: () => "fixture" }, modelRegistry: { refresh } } as unknown as ExtensionContext;
        bridge.start();
        t.after(() => shutdown());

        const piLogin = t.mock.method(ModelRuntime.prototype, "login");
        const piLogout = t.mock.method(ModelRuntime.prototype, "logout");
        assert.equal(start({ type: "session_start", reason: "startup" }, context), undefined);
        await completed;

        assert.equal(probe.mock.callCount(), 1);
        assert.equal(login.mock.callCount(), 0);
        assert.equal(refresh.mock.callCount(), 1);
        const record = readStoredCredential("agy", authPath);
        if (outcome === "success") {
          assert.equal(record?.type, "oauth");
          if (record?.type === "oauth") assert.equal(record.driver, driverId);
        } else if (outcome === "required") assert.equal(record, undefined);
        else assert.deepEqual(record, original);
        assert.equal(sendMessage.mock.callCount(), outcome === "required" && !hasUI ? 1 : 0);
        assert.equal(notify.mock.callCount(), 0);
        assert.equal(setStatus.mock.callCount(), outcome === "required" && hasUI ? 1 : 0);
        if (outcome === "required") {
          const message = hasUI ? setStatus.mock.calls[0]!.arguments[1] : sendMessage.mock.calls[0]!.arguments[0].content;
          assert.match(message, /\/login.*Antigravity \[pi-agy-bridge\]/);
        }

        start({ type: "session_start", reason: "startup" }, context);
        start({ type: "session_start", reason: "reload" }, context);
        await setImmediate();
        assert.equal(probe.mock.callCount(), 1);
        assert.equal(piLogin.mock.callCount(), outcome === "success" && saved !== "matching" ? 1 : 0);
        assert.equal(piLogout.mock.callCount(), outcome === "required" && saved !== "absent" ? 1 : 0);
        assert.equal(sendMessage.mock.callCount(), outcome === "required" && !hasUI ? 1 : 0);
        assert.equal(notify.mock.callCount(), 0);
        if (outcome === "required" && hasUI) assert.deepEqual(setStatus.mock.calls.at(-1)?.arguments, ["agy-bridge", undefined]);
      });
    }
  }
}
