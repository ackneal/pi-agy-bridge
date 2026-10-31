import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { defaultProviderAuthContext, type ApiKeyCredential, type Provider } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BridgeIPC } from "../bridge/ipc.ts";
import { parseModelsOutput } from "../discovery/models.ts";
import { Driver as AcpDriver } from "../drivers/acp/driver.ts";
import { Driver as CliDriver } from "../drivers/cli/driver.ts";
import type { BridgeDriver, DriverAuthentication, DriverId } from "../drivers/types.ts";
import { loginAgyAuthentication, probeAgyAuthentication } from "../runtime/auth.ts";
import { AgyRuntime } from "../runtime/process.ts";
import { AuthenticationRequiredError } from "../shared/types.ts";
import { registerAuthHomeFixture } from "./auth-home-fixture.ts";
import { AgyAuthentication, createAgyBridgeCredential, getAgyBridgeAuthEnvironment, isAgyBridgeEnabled } from "./auth.ts";
import { Bridge } from "./provider.ts";

const noProbeBackend: DriverAuthentication = {
  label: "Antigravity CLI",
  probe: async () => { throw new Error("Unexpected authentication probe"); },
  login: async () => { throw new Error("Unexpected authentication login"); },
};

const marker: ApiKeyCredential = { type: "api_key", env: { AGY_BRIDGE_ENABLED: "1" } };
const quota = { updatedAt: "now", groups: [] };

// --- Availability & Environment Tests ---

const credentials = [
  { name: "enabled", credential: marker, enabled: true },
  { name: "missing", credential: undefined, enabled: false },
  { name: "wrong marker", credential: { type: "api_key", env: { AGY_BRIDGE_ENABLED: "0" } } satisfies ApiKeyCredential, enabled: false },
];

for (const status of ["unknown", "authenticated", "unauthenticated"] as const) {
  for (const scenario of credentials) {
    for (const aborted of [false, true]) {
      test(`availability check: ${status}, ${scenario.name}, aborted=${aborted}`, async (t) => {
        const authentication = new AgyAuthentication(noProbeBackend, async () => {});
        t.after(() => authentication.close());
        authentication.status = status;
        const spawn = t.mock.method(cp, "spawn", () => { throw new Error("Antigravity CLI authentication timed out"); });
        syncBuiltinESMExports();
        t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
        const controller = new AbortController();
        const reason = new Error("cancelled availability");
        if (aborted) controller.abort(reason);

        const check = authentication.method.check!({
          ctx: defaultProviderAuthContext(), signal: controller.signal,
          ...(scenario.credential ? { credential: scenario.credential } : {}),
        });
        if (aborted) await assert.rejects(Promise.resolve(check), (error) => error === reason);
        else assert.deepEqual(await check, scenario.enabled ? { type: "api_key", source: "Antigravity CLI" } : undefined);

        const resolution = authentication.method.resolve({
          ctx: defaultProviderAuthContext(), signal: controller.signal,
          ...(scenario.credential ? { credential: scenario.credential } : {}),
        });
        if (aborted && scenario.enabled) await assert.rejects(Promise.resolve(resolution), (error) => error === reason);
        else assert.deepEqual(await resolution, scenario.enabled
          ? { auth: {}, env: { AGY_BRIDGE_ENABLED: "1" }, source: "Antigravity CLI" }
          : undefined);

        assert.equal(spawn.mock.callCount(), 0);
        assert.equal(authentication.status, status);
      });
    }
  }
}

test("boot availability preserves stored scoped model selection without authentication probing", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agy-availability-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
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
  t.mock.method(CliDriver.prototype, "discoverModels", async () =>
    parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)\ngemini-3.1-pro-high  Gemini 3.1 Pro (High)"));
  const registrationRefresh = t.mock.method(runtime, "refresh", runtime.refresh.bind(runtime));
  new Bridge({
    on: () => {}, registerCommand: () => {},
    registerProvider: runtime.registerNativeProvider.bind(runtime),
  } as unknown as ExtensionAPI, new CliDriver()).start();
  await Promise.all(registrationRefresh.mock.calls.map((call) => call.result));
  registrationRefresh.mock.restore();

  const refreshed = await runtime.refresh({ providers: ["agy"], allowNetwork: true });
  assert.equal(refreshed.errors.size, 0);
  assert.deepEqual(await runtime.checkAuth("agy"), { type: "api_key", source: "Antigravity CLI" });
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
  const authentication = new AgyAuthentication(noProbeBackend, async () => {});
  authentication.close();
  await assert.rejects(Promise.resolve(authentication.method.resolve({
    ctx: defaultProviderAuthContext(), credential: marker, signal: new AbortController().signal,
  })), /Antigravity CLI bridge session has ended/);
});

for (const scenario of [
  { name: "legacy", credential: marker, enabled: true },
  { name: "OAuth", credential: createAgyBridgeCredential(), enabled: true },
]) {
  test(`recognizes ${scenario.name} bridge credentials`, () => {
    assert.equal(isAgyBridgeEnabled(scenario.credential), scenario.enabled);
  });
}

// --- OAuth & Driver Resolution Tests ---

test("local OAuth renewal and validation use the constant bridge key", async (t) => {
  const spawn = t.mock.method(cp, "spawn", () => { throw new Error("Unexpected subprocess"); });
  syncBuiltinESMExports();
  t.after(() => {
    spawn.mock.restore();
    syncBuiltinESMExports();
  });
  const auth = new AgyAuthentication(noProbeBackend, async () => {});
  t.after(() => auth.close());
  const credential = { ...createAgyBridgeCredential(), expires: 0 };
  const refreshed = await auth.oauth.refresh(credential, new AbortController().signal);
  assert.deepEqual(refreshed, { ...credential, expires: refreshed.expires });
  assert.ok(refreshed.expires > Date.now());
  assert.equal(isAgyBridgeEnabled(refreshed), true);
  const derivedKey = "agy-bridge:enabled";
  assert.deepEqual(await auth.oauth.toAuth(refreshed), { apiKey: derivedKey });
  assert.deepEqual(getAgyBridgeAuthEnvironment(derivedKey), {
    AGY_BRIDGE_ENABLED: "1",
  });
  assert.equal(isAgyBridgeEnabled({ type: "api_key", key: derivedKey }), true);
  assert.deepEqual(await auth.method.resolve({
    ctx: { env: async () => undefined, fileExists: async () => false },
    credential: { type: "api_key", key: derivedKey },
    signal: new AbortController().signal,
  }), {
    auth: {},
    env: { AGY_BRIDGE_ENABLED: "1" },
    source: "Antigravity CLI",
  });
  assert.equal(auth.method.login, undefined);
  assert.equal(auth.oauth.isSubscription, true);
  assert.equal(spawn.mock.callCount(), 0);
});

for (const key of [undefined, "secret", "agy-bridge:", "agy-bridge:%", "agy-bridge:%20"]) {
  test(`reject invalid bridge API key ${key}`, () => {
    assert.equal(getAgyBridgeAuthEnvironment(key), undefined);
  });
}

for (const patch of [{ access: "secret" }, { refresh: "secret" }]) {
  test(`reject invalid OAuth credential ${JSON.stringify(patch)}`, async (t) => {
    const auth = new AgyAuthentication(noProbeBackend, async () => {});
    t.after(() => auth.close());
    const credential = { ...createAgyBridgeCredential(), ...patch };
    assert.equal(isAgyBridgeEnabled(credential), false);
    await assert.rejects(auth.oauth.toAuth(credential), /Invalid Antigravity CLI bridge credentials/);
    await assert.rejects(auth.oauth.refresh(credential, new AbortController().signal), /Invalid Antigravity CLI bridge credentials/);
  });
}

for (const driver of ["cli", "acp"] as const) {
  for (const recorded of [undefined, "cli", "acp"] as const) {
    test(`${driver} credential resolution with ${recorded ?? "legacy"} marker`, async () => {
      const auth = new AgyAuthentication({ label: "Fixture", probe: async () => true, login: async () => {} }, async () => {}, driver);
      const credential = { ...createAgyBridgeCredential(), ...(recorded ? { driver: recorded } : {}) };
      const allowed = recorded === undefined || recorded === driver;
      assert.equal(isAgyBridgeEnabled(credential, driver), allowed);
      if (allowed) assert.deepEqual(await auth.oauth.toAuth(credential), { apiKey: "agy-bridge:enabled" });
      else await assert.rejects(auth.oauth.toAuth(credential), /Invalid/);
      auth.close();
    });
  }

  test(`${driver} manual login records only the selected driver`, async () => {
    const backend = { label: "Fixture", probe: async () => true, login: async () => {} };
    const auth = new AgyAuthentication(backend, async () => {}, driver);
    const interaction = { signal: new AbortController().signal, notify: () => {}, prompt: async () => "" };
    try {
      const first = await auth.oauth.login(interaction);
      assert.equal(first.driver, driver);
      const next: DriverId = driver === "cli" ? "acp" : "cli";
      auth.setBackend(backend, next);
      const second = await auth.oauth.login(interaction);
      assert.equal(second.driver, next);
      assert.equal(first.driver, driver);
      await assert.rejects(auth.oauth.toAuth(first), /Invalid/);
    } finally {
      auth.close();
    }
  });
}

// --- Backend Switching Tests ---

for (const outcome of ["success", "failure"] as const) {
  test(`backend switch rejects stale detection: ${outcome}`, async (t) => {
    let finish!: (value: boolean) => void;
    let fail!: (error: Error) => void;
    let oldSignal!: AbortSignal;
    const pending = new Promise<boolean>((resolve, reject) => { finish = resolve; fail = reject; });
    const auth = new AgyAuthentication({
      label: "old", login: async () => {},
      probe: (signal) => { oldSignal = signal; return pending; },
    }, async () => {});
    t.after(() => auth.close());
    const detection = auth.detect(new AbortController().signal);
    const rejected = assert.rejects(detection, /backend changed|old probe failed/);

    auth.setBackend({ label: "new", login: async () => {}, probe: async () => false });
    assert.equal(oldSignal.aborted, true);
    assert.equal(await auth.detect(new AbortController().signal), undefined);
    if (outcome === "success") finish(true);
    else fail(new Error("old probe failed"));
    await rejected;

    assert.equal(auth.status, "unauthenticated");
    assert.equal(auth.failure, undefined);
    assert.equal(auth.usage, undefined);
    assert.equal(auth.oauth.name, "Antigravity");
    assert.equal(auth.method.name, "Antigravity");
  });
}

test("backend switch cancels an in-flight login without returning an old credential", async (t) => {
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  let oldSignal!: AbortSignal;
  const auth = new AgyAuthentication({
    label: "old", probe: async () => true,
    login: async ({ signal }) => { oldSignal = signal; await gate; },
  }, async () => {});
  t.after(() => { resume(); auth.close(); });
  const login = auth.oauth.login({ signal: new AbortController().signal, notify: () => {}, prompt: async () => "" });
  const rejected = assert.rejects(Promise.resolve(login), /backend changed/);
  await Promise.resolve();

  auth.setBackend({ label: "new", probe: async () => false, login: async () => {} });
  assert.equal(oldSignal.aborted, true);
  resume();
  await rejected;

  assert.equal(auth.status, "unknown");
  assert.equal(auth.failure, undefined);
  assert.equal(await auth.detect(new AbortController().signal), undefined);
});

// --- Usage Refresh Tests ---

for (const row of [
  { name: "quota confirms authentication without probing", usage: quota, authenticated: false, status: "authenticated", probes: 0 },
  { name: "no quota falls back to authenticated probe", authenticated: true, status: "authenticated", probes: 1 },
  { name: "no quota falls back to unauthenticated probe", authenticated: false, status: "unauthenticated", probes: 1 },
  { name: "authentication requirement clears quota", error: new AuthenticationRequiredError(), authenticated: true, status: "unauthenticated", probes: 0 },
  { name: "quota failure records usage error", error: new Error("quota unavailable"), authenticated: true, status: "unknown", probes: 0 },
  { name: "probe failure records authentication error", probeError: new Error("probe unavailable"), authenticated: true, status: "unknown", probes: 1 },
] as const) {
  test(`authentication refresh: ${row.name}`, async (t) => {
    const probe = t.mock.fn(async () => {
      if ("probeError" in row) throw row.probeError;
      return row.authenticated;
    });
    const auth = new AgyAuthentication({ label: "test", probe, login: async () => {} }, async () => {});
    t.after(() => auth.close());
    const usage = t.mock.fn(async () => {
      if ("error" in row) throw row.error;
      return "usage" in row ? row.usage : undefined;
    });

    const result = auth.refreshUsage(new AbortController().signal, { usage });
    if ("error" in row) await assert.rejects(result, row.error);
    else if ("probeError" in row) await assert.rejects(result, row.probeError);
    else assert.deepEqual(await result, "usage" in row ? row.usage : undefined);

    assert.equal(auth.status, row.status);
    assert.equal(usage.mock.callCount(), 1);
    assert.equal(probe.mock.callCount(), row.probes);
    assert.deepEqual(auth.usage, "usage" in row ? row.usage : undefined);
    assert.equal(auth.usageError?.message, "error" in row && !(row.error instanceof AuthenticationRequiredError) ? row.error.message : undefined);
    assert.equal(auth.failure?.message, "probeError" in row ? row.probeError.message : undefined);
  });
}

for (const capturesUsage of [false, true]) {
  test(`successful login clears previous quota error with captured usage=${capturesUsage}`, async (t) => {
    const auth = new AgyAuthentication({
      label: "test",
      probe: async () => false,
      login: async (_interaction, onUsage) => { if (capturesUsage) onUsage(quota); },
    }, async () => {});
    t.after(() => auth.close());
    const signal = new AbortController().signal;
    const error = new Error("quota unavailable");
    await assert.rejects(auth.refreshUsage(signal, { usage: async () => { throw error; } }), error);
    assert.equal(auth.usageError?.message, error.message);

    await auth.oauth.login({ signal, notify: () => {}, prompt: async () => { throw new Error("Unexpected prompt"); } });

    assert.equal(auth.status, "authenticated");
    assert.equal(auth.failure, undefined);
    assert.equal(auth.usageError, undefined);
    assert.deepEqual(auth.usage, capturesUsage ? quota : undefined);
  });
}

for (const replacement of ["cancel", "login", "backend", "close"] as const) {
  test(`authentication refresh ignores stale usage after ${replacement}`, async (t) => {
    let resolve!: (value: typeof quota) => void;
    const auth = new AgyAuthentication({ label: "test", probe: async () => false, login: async () => {} }, async () => {});
    t.after(() => auth.close());
    const controller = new AbortController();
    const refresh = auth.refreshUsage(controller.signal, { usage: () => new Promise((done) => { resolve = done; }) });

    if (replacement === "cancel") controller.abort(new Error("cancelled"));
    else if (replacement === "backend") auth.setBackend({ label: "new", probe: async () => false, login: async () => {} });
    else if (replacement === "close") auth.close();
    else await auth.oauth.login({ signal: controller.signal, notify: () => {}, prompt: async () => { throw new Error("Unexpected prompt"); } });
    resolve(quota);

    await assert.rejects(refresh);
    assert.equal(auth.usage, undefined);
    assert.equal(auth.status, replacement === "login" ? "authenticated" : "unknown");
    assert.equal(auth.usageError, undefined);
  });
}

// --- Reminder Tests ---

for (const action of ["expiry", "login success", "login failure", "driver switch", "session change", "shutdown", "overlapping doctor"] as const) {
  test(`temporary auth reminder: ${action}`, async (t) => {
    await registerAuthHomeFixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const handlers = new Map<string, (...args: any[]) => any>();
    const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
    const statuses: Array<string | undefined> = [];
    let provider!: Provider;
    let refreshed!: () => void;
    const ready = new Promise<void>((resolve) => { refreshed = resolve; });
    let usageEntered!: () => void;
    const entered = new Promise<void>((resolve) => { usageEntered = resolve; });
    let releaseUsage!: () => void;
    const usageGate = new Promise<void>((resolve) => { releaseUsage = resolve; });
    const driver: BridgeDriver = {
      id: "cli", label: "Antigravity CLI", sessionVersion: "test:v1", initialModels: [],
      authentication: {
        label: "CLI", probe: async () => false,
        login: async () => { if (action === "login failure") throw new Error("fixture login failure"); },
      },
      validateSelection() {}, detectExecutable: () => undefined,
      discoverModels: async () => [],
      usage: async () => {
        if (action === "overlapping doctor") { usageEntered(); await usageGate; }
        return undefined;
      },
      prepareSession: async () => { throw new Error("Unexpected runtime preparation"); },
    };
    const notify = t.mock.fn();
    const sendMessage = t.mock.fn();
    const bridge = new Bridge({
      on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
      registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, command.handler),
      registerProvider: (registered: Provider) => { provider = registered; },
      sendMessage,
    } as unknown as ExtensionAPI, driver);
    bridge.start();
    let doctor: Promise<void> | undefined;
    t.after(async () => { releaseUsage(); await doctor; await handlers.get("session_shutdown")!(); });
    const ctx = {
      hasUI: true,
      ui: { setStatus: (_key: string, message?: string) => statuses.push(message), notify },
      sessionManager: SessionManager.inMemory(), modelRegistry: { refresh: async () => { refreshed(); } },
    } as unknown as ExtensionCommandContext;

    handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    await ready;

    assert.equal(notify.mock.callCount(), 0);
    assert.equal(sendMessage.mock.callCount(), 0, "UI reminders must not leave a chat message");
    assert.match(statuses.at(-1)!, /not signed in.*\/login/);
    t.mock.timers.tick(7999);
    assert.match(statuses.at(-1)!, /not signed in/);

    if (action === "expiry") {
      t.mock.timers.tick(1);
    } else if (action === "login success" || action === "login failure") {
      const login = Promise.resolve(provider.auth.oauth!.login({
        signal: new AbortController().signal, notify: () => {},
        prompt: async () => { throw new Error("Unexpected login prompt"); },
      }));
      if (action === "login failure") {
        await assert.rejects(login, /fixture login failure/);
        assert.match(statuses.at(-1)!, /not signed in/);
        t.mock.timers.tick(1);
      } else await login;
    } else if (action === "driver switch") {
      t.mock.method(AcpDriver.prototype, "discoverModels", async () => []);
      await bridge.switchDriver("acp");
    } else if (action === "session change") {
      handlers.get("session_start")!({ type: "session_start", reason: "switch" }, ctx);
    } else if (action === "shutdown") {
      await handlers.get("session_shutdown")!();
    } else {
      doctor = commands.get("agy-bridge:doctor")!("", ctx);
      await entered;
      assert.match(statuses.at(-1)!, /Checking Antigravity CLI diagnostics/);
      t.mock.timers.tick(1);
      assert.match(statuses.at(-1)!, /Checking Antigravity CLI diagnostics/, "expiry must not clear newer progress");
      releaseUsage();
      await doctor;
    }

    assert.equal(statuses.at(-1), undefined);
    const count = statuses.length;
    t.mock.timers.tick(8000);
    assert.equal(statuses.length, count, "cancelled timers must not change later UI state");
  });
}

// --- Race & Concurrency Tests ---

function createAuthenticationRaceFixture(t: TestContext, beforeLogin: () => Promise<void> = async () => {}) {
  const children: ReturnType<typeof createChild>[] = [];
  function createChild() {
    return Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: () => true,
    });
  }
  const spawn = t.mock.method(cp, "spawn", (command: string, args: string[]) => {
    assert.equal(command, "/fake/agy");
    assert.deepEqual(args, ["--output-format", "json", "--print", "/usage"]);
    const child = createChild();
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  const auth = new AgyAuthentication({
    label: "Antigravity CLI",
    probe: (signal, onUsage) => probeAgyAuthentication("/fake/agy", signal, onUsage),
    login: (interaction, onUsage) => loginAgyAuthentication(interaction, "/fake/agy", onUsage),
  }, beforeLogin);
  t.after(() => {
    auth.close();
    for (const child of children) child.emit("close", 0, null);
    spawn.mock.restore();
    syncBuiltinESMExports();
  });
  return {
    auth, children,
    finish(index: number) {
      const child = children[index]!;
      assert.equal(child.stdin.writableEnded, false);
      child.stdout.write('Quota:\nGemini Models  Weekly Limit Remaining 100%\n');
      child.emit("close", 0, null);
    },
  };
}

for (const action of ["close", "abort"] as const) {
  test(`${action} prevents a pending login from returning a credential`, async (t) => {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const { auth, children } = createAuthenticationRaceFixture(t, () => gate);
    const controller = new AbortController();
    const login = Promise.resolve(auth.oauth.login({
      signal: controller.signal, notify: () => {}, prompt: async () => "",
    }));
    const rejected = assert.rejects(login);
    t.after(resume);

    if (action === "close") auth.close();
    else controller.abort();
    resume();
    await rejected;

    assert.equal(children.length, 0);
    assert.equal(auth.status, "unknown");
  });
}

test("pending login blocks concurrent login and resolution with an old marker", async (t) => {
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const { auth, children, finish } = createAuthenticationRaceFixture(t, () => gate);
  const signal = new AbortController().signal;
  const interaction = { signal, notify: () => {}, prompt: async () => "" };
  const login = auth.oauth.login(interaction);
  t.after(resume);

  await assert.rejects(Promise.resolve(auth.oauth.login(interaction)), /Antigravity CLI authentication is already in progress/);
  assert.equal(await auth.method.resolve({
    ctx: defaultProviderAuthContext(), signal,
    credential: { type: "api_key", env: { AGY_BRIDGE_ENABLED: "1" } },
  }), undefined);
  assert.equal(children.length, 0);

  resume();
  await Promise.resolve();
  finish(0);
  assert.equal((await login).type, "oauth");
});

test("login credentials and resolved environment do not depend on historical epochs", async (t) => {
  const { auth, children, finish } = createAuthenticationRaceFixture(t);
  const signal = new AbortController().signal;
  const login = auth.oauth.login({ signal, notify: () => {}, prompt: async () => "" });
  await Promise.resolve();
  finish(0);
  assert.equal((await login).type, "oauth");

  for (const env of [
    { AGY_BRIDGE_ENABLED: "1" },
    { AGY_BRIDGE_ENABLED: "1", AGY_BRIDGE_LOGIN_EPOCH: "legacy-epoch" },
  ]) {
    const context = { ctx: defaultProviderAuthContext(), signal, credential: { type: "api_key" as const, env } };
    assert.deepEqual(await auth.method.check!(context), { type: "api_key", source: "Antigravity CLI" });
    assert.deepEqual(await auth.method.resolve(context), {
      auth: {}, source: "Antigravity CLI", env: { AGY_BRIDGE_ENABLED: "1" },
    });
  }
  assert.equal(children.length, 1);
});

test("pending failed login never returns a success credential", async (t) => {
  let fail!: (error: Error) => void;
  const gate = new Promise<void>((_, reject) => { fail = reject; });
  const { auth, children } = createAuthenticationRaceFixture(t, () => gate);
  let credentialReturned = false;
  const login = Promise.resolve(auth.oauth.login({
    signal: new AbortController().signal, notify: () => {}, prompt: async () => "",
  })).then(() => { credentialReturned = true; });
  const rejected = assert.rejects(login, /before login failed/);
  await Promise.resolve();
  assert.equal(credentialReturned, false);
  assert.equal(children.length, 0);
  fail(new Error("before login failed"));
  await rejected;
  assert.equal(credentialReturned, false);
});

for (const outcome of ["authenticated", "unauthenticated", "abort", "close", "manual", "failure"] as const) {
  test(`detect deduplicates in flight: ${outcome}`, async (t) => {
    const { auth, children, finish } = createAuthenticationRaceFixture(t);
    const controller = new AbortController();
    const detection = auth.detect(controller.signal);
    const settled = detection.then(value => ({ value }), error => ({ error }));
    const concurrent = auth.detect(new AbortController().signal);
    const concurrentSettled = concurrent.then(value => ({ value }), error => ({ error }));
    assert.equal(children.length, 1);

    if (outcome === "authenticated") finish(0);
    else if (outcome === "unauthenticated") {
      children[0]!.stderr.write("Authentication required\n");
      children[0]!.emit("close", 0, null);
    } else if (outcome === "failure") children[0]!.emit("close", 1, null);
    else {
      if (outcome === "abort") controller.abort();
      if (outcome === "close") auth.close();
      if (outcome === "manual") {
        const login = auth.oauth.login({ signal: new AbortController().signal, notify: () => {}, prompt: async () => "" });
        await Promise.resolve();
        finish(1);
        await login;
      }
      finish(0);
    }

    const result = await settled;
    if (outcome === "authenticated") {
      assert.ok("value" in result && result.value?.type === "oauth");
      assert.equal(auth.status, "authenticated");
    } else if (outcome === "unauthenticated") {
      assert.deepEqual(result, { value: undefined });
      assert.equal(auth.status, "unauthenticated");
    } else {
      assert.ok("error" in result);
      if (outcome === "manual") assert.equal(auth.status, "authenticated");
      if (outcome === "failure") assert.ok(auth.failure);
    }
    const sharedResult = await concurrentSettled;
    if (outcome === "abort") {
      assert.ok("value" in sharedResult && sharedResult.value?.type === "oauth");
      assert.equal(auth.status, "authenticated");
      assert.equal(auth.failure, undefined);
    } else assert.deepEqual(sharedResult, result);

    const retry = auth.detect(new AbortController().signal);
    if (outcome === "close") {
      await assert.rejects(retry, /session has ended/);
    } else {
      const index = outcome === "manual" ? 2 : 1;
      assert.equal(children.length, index + 1);
      finish(index);
      assert.ok((await retry)?.type === "oauth");
    }
  });
}

test("slow detection leaves credential checks and resolution spawn-free", async (t) => {
  const { auth, children, finish } = createAuthenticationRaceFixture(t);
  const signal = new AbortController().signal;
  const detection = auth.detect(signal);
  let settled = false;
  void detection.then(() => { settled = true; });

  children[0]!.stdout.write("Quota:\n");
  await Promise.resolve();
  assert.equal(settled, false, "a quota heading must wait for natural close");

  for (const enabled of [false, true]) {
    const credential = { type: "api_key" as const, env: { AGY_BRIDGE_ENABLED: enabled ? "1" : "0" } };
    const context = { ctx: defaultProviderAuthContext(), signal, credential };
    assert.deepEqual(await auth.method.check!(context), enabled ? { type: "api_key", source: "Antigravity CLI" } : undefined);
    assert.deepEqual(await auth.method.resolve(context), enabled ? {
      auth: {}, source: "Antigravity CLI", env: { AGY_BRIDGE_ENABLED: "1" },
    } : undefined);
    assert.equal(children.length, 1);
  }

  finish(0);
  assert.ok((await detection)?.type === "oauth");
});

for (const output of ["", "Remaining 100%\n"]) {
  test(`invalid quota leaves detection unknown: ${JSON.stringify(output)}`, async (t) => {
    const { auth, children } = createAuthenticationRaceFixture(t);
    const detection = auth.detect(new AbortController().signal);
    const rejected = assert.rejects(detection, (error: Error) => {
      assert.match(error.message, /returned no quota data/);
      return true;
    });
    children[0]!.stdout.write(output);
    children[0]!.emit("close", 0, null);

    await rejected;
    assert.equal(auth.status, "unknown");
    assert.equal(children.length, 1);
  });
}

for (const caller of ["first", "second", "pre-aborted"] as const) {
  test(`caller cancellation is isolated: ${caller}`, async (t) => {
    const { auth, children, finish } = createAuthenticationRaceFixture(t);
    const cancelled = new AbortController();
    const reason = new Error("caller cancelled");
    if (caller === "pre-aborted") cancelled.abort(reason);
    const first = auth.detect(caller === "first" ? cancelled.signal : new AbortController().signal);
    const second = auth.detect(caller === "first" ? new AbortController().signal : cancelled.signal);
    const rejected = assert.rejects(caller === "first" ? first : second, error => error === reason);

    cancelled.abort(reason);
    await rejected;
    assert.equal(children.length, 1);
    assert.equal(auth.status, "unknown");
    assert.equal(auth.failure, undefined);
    finish(0);
    assert.ok((await (caller === "first" ? second : first))?.type === "oauth");
    assert.equal(auth.status, "authenticated");
  });
}

for (const loginOutcome of ["success", "failure"] as const) {
  test(`stale detection cleanup preserves new probe after login ${loginOutcome}`, async (t) => {
    const { auth, children, finish } = createAuthenticationRaceFixture(t, async () => {
      if (loginOutcome === "failure") throw new Error("login failed");
    });
    const signal = new AbortController().signal;
    const stale = assert.rejects(auth.detect(signal), { name: "AbortError" });
    const login = auth.oauth.login({ signal, notify: () => {}, prompt: async () => "" });
    await assert.rejects(auth.detect(signal), /replaced by a newer attempt/);
    if (loginOutcome === "success") {
      finish(1);
      await login;
    } else await assert.rejects(Promise.resolve(login), /login failed/);

    const fresh = auth.detect(signal);
    const index = children.length - 1;
    finish(0);
    await stale;
    const joined = auth.detect(signal);
    assert.equal(children.length, index + 1);
    finish(index);
    assert.equal(await fresh, await joined);
    assert.equal(auth.status, "authenticated");
    assert.equal(auth.failure, undefined);
  });
}

// --- Native Auth Integration Tests ---

for (const scenario of ["native logout and relogin", "native URL and code login", "cancelled login", "headless unknown never retries"] as const) {
  test(`native auth integration: ${scenario}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-native-auth-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    t.after(() => {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    });
    const executable = path.join(directory, "agy");
    await writeFile(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo 1.2.16\nelse\n  exit 1\nfi\n', { mode: 0o755 });
    const children = new Map<number, EventEmitter>();
    const writes: string[] = [];
    let authenticated = true;
    let processCount = 0;
    let started: (() => void) | undefined;
    const processStarted = new Promise<void>((resolve) => { started = resolve; });
    let closed: (() => void) | undefined;
    const processClosed = new Promise<void>((resolve) => { closed = resolve; });
    const spawnMock = t.mock.method(cp, "spawn", (command: string, args: string[]) => {
      assert.ok(command === executable || command === "/bin/sh");
      if (command === executable) assert.deepEqual(args, ["--output-format", "json", "--print", "/usage"]);
      else {
        const invocation = args.join(" ");
        assert.match(invocation, /--print[' ]+[' ]*\/usage/);
        assert.ok(!invocation.includes("--disable-slash-commands"));
        assert.ok(!invocation.includes("--model"));
      }
      assert.ok(!args.some((arg) => /logout/i.test(arg)));
      const pid = 900_000_000 + ++processCount;
      const input = new PassThrough();
      const output = new PassThrough();
      const errors = new PassThrough();
      const control = new PassThrough();
      const gate = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        pid, stdout: output, stderr: errors, stdin: input,
        stdio: [input, output, errors, control, gate], kill: () => true,
      });
      children.set(pid, child);
      child.once("close", () => { children.delete(pid); });
      const finish = () => {
        output.write(scenario === "headless unknown never retries" ? "  Quota:  \r\n  Limit Remaining 100%\r\n" : "Quota:\nGemini Models  Weekly Limit Remaining 100%\n");
        children.delete(pid);
        child.emit("close", 0, null);
      };
      input.on("data", (data) => {
        writes.push(data.toString());
        if (scenario === "native URL and code login") {
          assert.equal(data.toString(), "authorization-code\n");
          authenticated = true;
          assert.equal(input.writableEnded, false, "interactive PTY input remains writable");
          queueMicrotask(finish);
        }
      });
      gate.on("data", (data) => {
        assert.equal(data.toString(), "start\n");
        errors.write("Authentication required. Please visit the URL to log in:\nhttps://accounts.google.com/o/oauth2/auth?state=test\nOr, paste the authorization code here and press Enter:");
      });
      queueMicrotask(() => {
        started?.();
        if (scenario === "cancelled login") return;
        if (command === "/bin/sh") {
          control.write(`${pid + 10_000} ${pid + 10_000}\n`);
          return;
        }
        if (scenario === "native URL and code login" && processCount === 1) {
          errors.write("Authentication required\n");
          return;
        }
        assert.equal(input.writableEnded, false, "ignored probe stdin needs no writes");
        if (scenario === "headless unknown never retries") {
          child.emit("close", 0, null);
          return;
        }
        if (authenticated) finish();
        else child.stderr.write("Error: authentication required. Run agy to log in.\n");
      });
      return child;
    });
    const spawnSyncMock = t.mock.method(cp, "spawnSync", (command: string, args: string[]) => {
      assert.equal(command, "/bin/ps");
      assert.deepEqual(args, ["-o", "pgid=", "-p", String(process.pid)]);
      return { status: 0, stdout: `${process.pid}\n`, stderr: "" };
    });
    const killMock = t.mock.method(process, "kill", (pid: number) => {
      const child = children.get(-pid);
      if (child) {
        children.delete(-pid);
        queueMicrotask(() => { child.emit("close", null, "SIGTERM"); closed?.(); });
      }
      return true;
    });
    syncBuiltinESMExports();
    t.after(async () => {
      spawnMock.mock.restore();
      spawnSyncMock.mock.restore();
      killMock.mock.restore();
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
    });
    const runtime = await ModelRuntime.create({
      modelsPath: null, authPath: path.join(directory, "auth.json"), refreshOnCreate: false,
    });
    let provider: Provider | undefined;
    const commands: string[] = [];
    const models = parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)");
    t.mock.method(CliDriver.prototype, "detectExecutable", () => executable);
    t.mock.method(CliDriver.prototype, "discoverModels", async () => models);
    new Bridge({
      on: () => {}, registerCommand: (name: string) => commands.push(name),
      getActiveTools: () => [], getAllTools: () => [],
      registerProvider: (registered: Provider) => {
        provider = registered;
        runtime.registerNativeProvider(registered);
      },
    } as unknown as ExtensionAPI, new CliDriver()).start();
    await runtime.refresh({ providers: ["agy"], allowNetwork: true });
    assert.ok(provider?.auth.oauth?.login);
    assert.equal(provider.auth.oauth.isSubscription, true);
    assert.deepEqual(commands, ["agy-bridge:doctor", "agy-bridge:driver"]);
    assert.deepEqual(await runtime.getAvailable("agy"), []);
    assert.equal(processCount, 0, "availability checks must not launch authentication");
    const controller = new AbortController();
    const progress: string[] = [];
    const interaction = {
      signal: controller.signal,
      notify: (event: { type: string; url?: string; message?: string }) => {
        if (event.type === "progress") {
          progress.push(event.message ?? "");
          return;
        }
        assert.equal(scenario, "native URL and code login");
        if (event.type === "auth_url") assert.equal(event.url, "https://accounts.google.com/o/oauth2/auth?state=test");
      },
      prompt: async (request: { type: string }) => {
        assert.equal(scenario, "native URL and code login");
        assert.equal(request.type, "manual_code");
        return "authorization-code";
      },
    };
    const login = runtime.login("agy", "oauth", interaction);

    if (scenario === "cancelled login") {
      const rejected = assert.rejects(login);
      await processStarted;
      assert.match(progress[0] ?? "", /Checking Antigravity CLI authentication status/);
      controller.abort();
      await rejected;
      await processClosed;
      assert.deepEqual(await runtime.listCredentials(), []);
      assert.deepEqual(await runtime.getAvailable("agy"), []);
      assert.equal(children.size, 0);
      assert.deepEqual(writes, []);
      return;
    }

    if (scenario === "headless unknown never retries") {
      await assert.rejects(login, /returned no quota data/);
      assert.equal(processCount, 1, "unknown status must not launch a PTY retry");
      assert.deepEqual(await runtime.listCredentials(), []);
      assert.deepEqual(await runtime.getAvailable("agy"), []);
      assert.deepEqual(writes, []);
      return;
    }

    const credential = await login;
    await runtime.refresh({ providers: ["agy"], allowNetwork: true });
    assert.match(progress[0] ?? "", /Checking Antigravity CLI authentication status/);
    assert.ok(credential.type === "oauth");
    assert.equal(credential.access, "");
    assert.equal(credential.refresh, "");
    assert.equal("loginEpoch" in credential, false);
    assert.equal(runtime.isUsingSubscription("agy"), true);
    assert.equal((await runtime.getAvailable("agy")).length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "auth.json"), "utf8")), { agy: credential });
    assert.deepEqual(await runtime.listCredentials(), [{ providerId: "agy", type: "oauth" }]);
    await runtime.logout("agy");
    assert.deepEqual(await runtime.getAvailable("agy"), []);
    assert.equal(runtime.isUsingSubscription("agy"), false);
    assert.equal(authenticated, true, "Pi logout must leave Antigravity CLI's external login untouched");
    const countBeforeDisabledRequest = processCount;
    const disabled = await runtime.streamSimple(models[0]!, { messages: [] }, { sessionId: "auth-test" }).result();
    assert.equal(disabled.stopReason, "error");
    assert.match(disabled.errorMessage ?? "", /not configured/);
    assert.equal(processCount, countBeforeDisabledRequest, "disabled requests must not launch Antigravity CLI");

    const relogin = await runtime.login("agy", "oauth", interaction);
    await runtime.refresh({ providers: ["agy"], allowNetwork: true });
    assert.ok(relogin.type === "oauth");
    assert.equal("loginEpoch" in relogin, false);
    assert.equal((await runtime.getAvailable("agy")).length, 1);
    authenticated = false;
    const countBeforeExpiredRequest = processCount;
    t.mock.method(BridgeIPC.prototype, "start", async () => {});
    t.mock.method(BridgeIPC.prototype, "close", async () => {});
    t.mock.getter(BridgeIPC.prototype, "bridgeUri", () => "unix:///synthetic.sock?session=test");
    t.mock.method(CliDriver.prototype, "installPlugin", async () => {});
    const startRuntime = t.mock.method(AgyRuntime.prototype, "start", async () => {
      throw new Error("Authentication required. Run agy to log in.");
    });
    const expired = await runtime.streamSimple(models[0]!, { messages: [] }, { sessionId: "auth-test" }).result();
    assert.equal(expired.stopReason, "error");
    assert.match(expired.errorMessage ?? "", /Authentication required/);
    assert.equal(startRuntime.mock.callCount(), 1, "expired login must be reported by the runtime, not an auth probe");
    assert.equal(processCount, countBeforeExpiredRequest, "requests must not launch a separate authentication process");
    assert.equal((await runtime.getAvailable("agy")).length, 1,
      "configured models remain selectable even when Antigravity CLI authentication expires");
    assert.deepEqual(writes, scenario === "native URL and code login" ? ["authorization-code\n"] : [],
      "authentication may only send an authorization code, never a user/model request");
    assert.equal(children.size, 0);
  });
}
