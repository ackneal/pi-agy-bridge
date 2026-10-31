import { useAuthHomeFixture } from "./auth-home-fixture.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { ModelRuntime, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { Driver as CliDriver } from "../drivers/cli/driver.ts";
import { Driver as AcpDriver } from "../drivers/acp/driver.ts";
import { Connection as AcpConnection } from "../drivers/acp/connection.ts";
import { useExecutable } from "../drivers/acp/executable-fixture.ts";
import { AgyAuthentication } from "./auth.ts";
import { parseModelsOutput } from "../discovery/models.ts";
import { Bridge } from "./provider.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

useAuthHomeFixture();

for (const failure of ["installation", "initialization", "session", "authentication"] as const) {
  test(`default ACP never falls back to installed CLI after ${failure} failure`, async (t) => {
    let provider!: Provider;
    const bridge = new Bridge({
      on: () => {}, registerCommand: () => {},
      registerProvider: (registered: Provider) => { provider = registered; },
    } as unknown as ExtensionAPI, new AcpDriver(async () => { throw new Error("synthetic installation failure"); }));
    useExecutable(t, failure === "installation" ? undefined : process.execPath);
    const start = t.mock.method(AcpConnection.prototype, "start", async () => {
      if (failure === "initialization") throw new Error("synthetic initialization failure");
      return { protocolVersion: acp.PROTOCOL_VERSION };
    });
    t.mock.method(AcpConnection.prototype, "request", async () => {
      if (failure === "authentication") throw acp.RequestError.authRequired();
      throw new Error("synthetic session failure");
    });
    const cliDetection = t.mock.method(CliDriver.prototype, "detectExecutable", () => process.execPath);
    const cliDiscovery = t.mock.method(CliDriver.prototype, "discoverModels", async () => []);
    bridge.start();

    await assert.rejects(Promise.resolve(provider.auth.oauth!.login({
      signal: new AbortController().signal, notify: () => {},
      prompt: async () => { throw new Error("Unexpected authentication prompt"); },
    })));

    assert.equal(bridge.driver.id, "acp");
    assert.equal(provider.auth!.oauth!.name, "Antigravity");
    assert.ok(provider.getModels().some((model) => model.id === "gemini-3.8-flash"));
    assert.equal(start.mock.callCount(), failure === "installation" ? 0 : 1);
    assert.equal(cliDetection.mock.callCount(), 0);
    assert.equal(cliDiscovery.mock.callCount(), 0);
  });
}

test("manual CLI selection applies to this bridge instance, not the next startup", async (t) => {
  const providers: Provider[] = [];
  const pi = {
    on: () => {}, registerCommand: () => {},
    registerProvider: (provider: Provider) => { providers.push(provider); },
  } as unknown as ExtensionAPI;
  t.mock.method(CliDriver.prototype, "detectExecutable", () => process.execPath);
  t.mock.method(CliDriver.prototype, "discoverModels", async () => parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)"));
  const bridge = new Bridge(pi);
  bridge.start();
  assert.equal(bridge.driver.id, "acp");

  await bridge.switchDriver("cli");
  const reopened = new Bridge(pi);
  reopened.start();

  assert.equal(bridge.driver.id, "cli");
  assert.equal(reopened.driver.id, "acp");
  assert.equal(providers[1]?.name, "Antigravity [pi-agy-bridge]");
  assert.equal(providers[2]?.name, "Antigravity [pi-agy-bridge]");
});

type DriverMenuScenario = {
  name: string;
  current?: "cli";
  args?: string;
  hasUI?: false;
  selected?: string;
  target?: "acp" | "cli";
  outcome: "doctorFailure" | "success" | "failure" | "same" | "cancel" | "status" | "invalid";
};

const driverMenuScenarios: DriverMenuScenario[] = [
  { name: "default ACP menu switches to CLI", selected: "CLI", target: "cli", outcome: "success" },
  { name: "CLI menu switches to ACP", current: "cli", selected: "ACP", target: "acp", outcome: "success" },
  { name: "current ACP selection does not switch", selected: "ACP (current)", outcome: "same" },
  { name: "current CLI selection does not switch", current: "cli", selected: "CLI (current)", outcome: "same" },
  { name: "cancelled menu has no side effects", outcome: "cancel" },
  { name: "doctor failure does not undo successful switch", selected: "CLI", target: "cli", outcome: "doctorFailure" },
  { name: "CLI switch failure is reported", selected: "CLI", target: "cli", outcome: "failure" },
  { name: "explicit CLI bypasses menu", args: " CLI ", target: "cli", outcome: "success" },
  { name: "explicit ACP bypasses menu", current: "cli", args: "acp", target: "acp", outcome: "success" },
  { name: "explicit current driver bypasses menu", args: "acp", outcome: "same" },
  { name: "explicit invalid driver bypasses menu", args: "other", outcome: "invalid" },
  { name: "headless default ACP reports status", hasUI: false, outcome: "status" },
  { name: "headless CLI reports status", current: "cli", hasUI: false, outcome: "status" },
];

for (const scenario of driverMenuScenarios) {
  test(`driver command: ${scenario.name}`, async (t) => {
    let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    const sendMessage = t.mock.fn();
    const registerProvider = t.mock.fn();
    const pi = {
      on: () => {}, sendMessage, registerProvider,
      registerCommand: (name: string, options: { handler: typeof command }) => {
        if (name === "agy-bridge:driver") command = options.handler;
      },
    } as unknown as ExtensionAPI;
    const acpDetection = t.mock.method(AcpDriver.prototype, "detectExecutable", () => scenario.outcome === "status" ? "/mock/acp" : undefined);
    const cliDetection = t.mock.method(CliDriver.prototype, "detectExecutable", () => {
      if (scenario.outcome === "doctorFailure") throw new Error("synthetic diagnostics failure");
      return undefined;
    });
    t.mock.method(AgyAuthentication.prototype, "detect", async () => undefined);
    const bridge = scenario.current === "cli" ? new Bridge(pi, new CliDriver()) : new Bridge(pi);
    t.after(() => bridge.liveSessions.disposeAll());
    const acpUsage = t.mock.method(AcpDriver.prototype, "usage", async () => undefined);
    const cliUsage = t.mock.method(CliDriver.prototype, "usage", async () => undefined);
    bridge.start();
    const registrations = registerProvider.mock.callCount();
    const label = bridge.driver.label;
    const current = bridge.driver.id;
    const switchDriver = t.mock.method(bridge, "switchDriver", async (target: "acp" | "cli") => {
      if (scenario.outcome === "failure") throw new Error("synthetic switch failure");
      bridge.driver = target === "cli" ? new CliDriver() : new AcpDriver();
    });
    const select = t.mock.fn(async () => scenario.selected);
    const modelRegistry = { refresh: async () => {} } as unknown as ExtensionCommandContext["modelRegistry"];
    const setStatus = t.mock.fn();
    const ctx = {
      hasUI: scenario.hasUI !== false, ui: { select, setStatus }, modelRegistry,
    } as unknown as ExtensionCommandContext;

    await command(scenario.args ?? "", ctx);

    const menu = !scenario.args && ctx.hasUI;
    assert.equal(select.mock.callCount(), menu ? 1 : 0);
    if (menu) {
      assert.deepEqual(select.mock.calls[0]!.arguments, [
        "Select Antigravity driver",
        current === "acp" ? ["ACP (current)", "CLI"] : ["ACP", "CLI (current)"],
      ]);
    }
    assert.equal(switchDriver.mock.callCount(), scenario.target ? 1 : 0);
    if (scenario.target) assert.deepEqual(switchDriver.mock.calls[0]!.arguments, [scenario.target, modelRegistry]);
    assert.equal(registerProvider.mock.callCount(), registrations);
    const succeeded = scenario.outcome === "success" || scenario.outcome === "doctorFailure";
    const targetLabel = scenario.target === "cli" ? "Antigravity CLI" : "Antigravity ACP";
    assert.equal(acpUsage.mock.callCount(), succeeded && scenario.target === "acp" ? 1 : 0);
    assert.equal(cliUsage.mock.callCount(), succeeded && scenario.target === "cli" ? 1 : 0);
    assert.equal(acpDetection.mock.callCount(), scenario.outcome === "status" || (succeeded && scenario.target === "acp") ? 1 : 0);
    assert.equal(cliDetection.mock.callCount(), scenario.outcome === "status" || (succeeded && scenario.target === "cli") ? 1 : 0);
    assert.deepEqual(setStatus.mock.calls.map(call => call.arguments), [
      ...(scenario.target ? [["agy-bridge", `Switching to ${targetLabel}…`], ["agy-bridge", undefined]] : []),
      ...(succeeded ? [["agy-bridge", `Checking ${targetLabel} diagnostics…`], ["agy-bridge", undefined]] : []),
    ]);

    if (scenario.outcome === "cancel") {
      assert.equal(sendMessage.mock.callCount(), 0);
      return;
    }
    const contents = {
      failure: "Failed to switch driver: synthetic switch failure",
      same: `Already using driver: **${label}** (${current}).`,
      invalid: 'Unknown driver "other". Available: cli, acp.',
      status: [
        `Current driver: **${label}** (${current})`,
        "Default: ACP. Driver changes are explicit; automatic fallback is disabled.",
        "", "Available drivers:", "- **acp**: ✓ Found (/mock/acp)", "- **cli**: ✗ Not found", "",
        "Usage: `/agy-bridge:driver cli` or `/agy-bridge:driver acp`",
      ].join("\n"),
    };
    assert.equal(sendMessage.mock.callCount(), 1);
    if (scenario.outcome === "success" || scenario.outcome === "doctorFailure") {
      assert.equal(bridge.driver.id, scenario.target);
      const [report, options] = sendMessage.mock.calls[0]!.arguments;
      assert.equal(report.customType, "pi-agy-bridge:doctor");
      assert.equal(report.display, true);
      assert.deepEqual(options, { triggerTurn: false });
      if (scenario.outcome === "doctorFailure") {
        assert.equal(report.content, "Failed to collect diagnostics: synthetic diagnostics failure");
      } else {
        assert.match(report.content, /^agy-bridge doctor\n/);
        assert.ok(report.content.includes(targetLabel));
      }
    } else {
      assert.deepEqual(sendMessage.mock.calls[0]!.arguments, [
        { customType: "pi-agy-bridge:driver", content: contents[scenario.outcome], display: true },
        { triggerTurn: false },
      ]);
    }
  });
}

for (const scenario of [
  { name: "refresh success", refreshFailure: false, discoveryFailure: false, doctorFailure: false },
  { name: "refresh rejection", refreshFailure: true, discoveryFailure: false, doctorFailure: false },
  { name: "discovery rejection", refreshFailure: false, discoveryFailure: true, doctorFailure: false },
  { name: "refresh rejection with doctor detection failure", refreshFailure: true, discoveryFailure: false, doctorFailure: true },
] as const) {
  test(`driver switch handles ${scenario.name}`, async (t) => {
    t.mock.method(AgyAuthentication.prototype, "detect", async () => undefined);
    type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    let command!: Handler;
    const providers: Provider[] = [];
    const sendMessage = t.mock.fn();
    const setStatus = t.mock.fn();
    const bridge = new Bridge({
      on: () => {}, sendMessage,
      registerCommand: (name: string, options: { handler: Handler }) => {
        if (name === "agy-bridge:driver") command = options.handler;
      },
      registerProvider: (provider: Provider) => { providers.push(provider); },
    } as unknown as ExtensionAPI, new CliDriver());
    t.after(() => bridge.liveSessions.disposeAll());
    const catalog = parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)");
    t.mock.method(AcpDriver.prototype, "discoverModels", async () => {
      if (scenario.discoveryFailure) throw new Error("synthetic discovery failure");
      return catalog.map((model) => ({ ...model, agyDriver: "acp" as const }));
    });
    t.mock.method(AcpDriver.prototype, "usage", async () => undefined);
    t.mock.method(AcpDriver.prototype, "detectExecutable", () => {
      if (scenario.doctorFailure) throw new Error("synthetic diagnostics failure");
      return undefined;
    });
    bridge.start();
    const refresh = t.mock.fn(async (_options: unknown) => {
      if (scenario.refreshFailure) throw new Error("synthetic registry failure");
    });
    const registry = { refresh } as unknown as ExtensionContext["modelRegistry"];

    await command("acp", { hasUI: true, ui: { setStatus }, modelRegistry: registry } as unknown as ExtensionCommandContext);

    assert.equal(refresh.mock.callCount(), scenario.discoveryFailure ? 0 : 2);
    for (const call of refresh.mock.calls) assert.deepEqual(call.arguments, [{ providers: ["agy"], allowNetwork: false }]);
    assert.equal(providers.length, scenario.discoveryFailure ? 1 : 2);
    assert.equal(bridge.driver.id, scenario.discoveryFailure ? "cli" : "acp");
    if (!scenario.discoveryFailure) assert.equal(providers.at(-1)!.getModels()[0]?.id, "gemini-3.8-flash");
    assert.equal(sendMessage.mock.callCount(), 1);
    const [message] = sendMessage.mock.calls[0]!.arguments as unknown as [{ customType: string; content: string }];
    assert.equal(message.customType, scenario.discoveryFailure ? "pi-agy-bridge:driver" : "pi-agy-bridge:doctor");
    if (scenario.discoveryFailure) assert.match(message.content, /Failed to switch driver: synthetic discovery failure/);
    else {
      if (scenario.doctorFailure) assert.match(message.content, /^Failed to collect diagnostics: synthetic diagnostics failure/);
      else assert.match(message.content, /^agy-bridge doctor\n/);
      assert.doesNotMatch(message.content, /Failed to switch driver/);
      if (scenario.refreshFailure) assert.match(message.content, /Warning[\s\S]*Pi model registry refresh failed: synthetic registry failure/);
      else assert.doesNotMatch(message.content, /registry refresh failed/);
    }
    assert.deepEqual(setStatus.mock.calls.map((call) => call.arguments.at(-1)), [
      "Switching to Antigravity ACP…", undefined,
      ...(!scenario.discoveryFailure ? ["Checking Antigravity ACP diagnostics…", undefined] : []),
    ]);
  });
}

for (const result of ["success", "installation failure"] as const) {
  test(`switch to uninstalled ACP attempts preparation: ${result}`, async (t) => {
    useExecutable(t, undefined);
    const discovery = t.mock.method(AcpDriver.prototype, "discoverModels", async function(this: AcpDriver) {
      assert.equal(typeof this.onInstallationProgress, "function");
      if (result === "installation failure") throw new Error("synthetic ACP installation failure");
      return [];
    });
    const bridge = new Bridge({ on() {}, registerCommand() {}, registerProvider() {} } as unknown as ExtensionAPI, new CliDriver());
    t.after(() => bridge.liveSessions.disposeAll());
    const disposal = t.mock.method(bridge.liveSessions, "disposeAll", async () => {});
    bridge.start();
    if (result === "success") {
      await bridge.switchDriver("acp");
      assert.equal(bridge.driver.id, "acp");
      assert.equal(disposal.mock.callCount(), 1);
    } else {
      await assert.rejects(bridge.switchDriver("acp"), /synthetic ACP installation failure/);
      assert.equal(bridge.driver.id, "cli");
      assert.equal(disposal.mock.callCount(), 0);
    }
    assert.equal(discovery.mock.callCount(), 1);
  });
}

async function mockDriverSwitchExecutables(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agy-switch-executables-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agyPath = path.join(directory, "agy");
  await writeFile(agyPath, '#!/bin/sh\nprintf "gemini-3.8-flash-high  Gemini 3.8 Flash (High)\\n"\n', { mode: 0o755 });
  t.mock.method(AcpConnection.prototype, "start", async () => ({ protocolVersion: acp.PROTOCOL_VERSION }));
  t.mock.method(AcpConnection.prototype, "request", async (method: string) => {
    assert.equal(method, acp.methods.agent.session.new);
    return {
      sessionId: "switch-discovery", configOptions: [{
        id: "model", name: "Model", type: "select", currentValue: "gemini-3.8-flash",
        options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }],
      }],
    };
  });
  t.mock.method(CliDriver.prototype, "detectExecutable", () => agyPath);
  useExecutable(t, process.execPath);
}

for (const scenario of [
  { from: "acp", to: "cli", late: "success" },
  { from: "cli", to: "acp", late: "failure" },
] as const) {
  test(`driver switch ${scenario.from} to ${scenario.to} refreshes catalog and ignores stale ${scenario.late}`, async (t) => {
    const registrations: Provider[] = [];
    let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    const pi = {
      on: () => {}, sendMessage: () => {},
      registerCommand: (name: string, options: { handler: typeof command }) => {
        if (name === "agy-bridge:driver") command = options.handler;
      },
      registerProvider: (provider: Provider) => { registrations.push(provider); },
    } as unknown as ExtensionAPI;
    await mockDriverSwitchExecutables(t);
    const bridge = new Bridge(pi, scenario.from === "cli" ? new CliDriver() : new AcpDriver());
    t.after(() => bridge.liveSessions.disposeAll());
    bridge.start();
    const oldProvider = registrations[0]!;
    const oldModels = parseModelsOutput("claude-sonnet-4-6  Claude Sonnet 4.6 (Thinking)");
    let finish!: (models: typeof oldModels) => void;
    let fail!: (error: Error) => void;
    const pending = new Promise<typeof oldModels>((resolve, reject) => { finish = resolve; fail = reject; });
    t.mock.method(bridge.driver, "discoverModels", () => pending);
    const oldSignal = new AbortController();
    let stalePublications = 0;
    const oldRefresh = oldProvider.refreshModels!({
      stored: { models: scenario.from === "acp" ? oldModels.map((model) => ({ ...model, agyDriver: "acp" })) : oldModels },
      allowNetwork: true, signal: oldSignal.signal,
      publish: async (publication) => {
        if (publication.persist) stalePublications++;
        publication.update?.();
        return true;
      },
    });
    const settled = Promise.resolve(oldRefresh).catch((error: unknown) => error);
    await Promise.resolve();
    assert.equal(oldProvider.getModels()[0]?.id, "claude-sonnet-4-6");
    let refreshes = 0;
    const modelRegistry = {
      refresh: async (options: unknown) => {
        refreshes++;
        assert.deepEqual(options, { providers: ["agy"], allowNetwork: false });
        const provider = registrations.at(-1)!;
        assert.equal(provider.getModels()[0]?.id, "gemini-3.8-flash");
        await provider.refreshModels!({
          stored: { models: oldModels },
          allowNetwork: false, signal: new AbortController().signal,
          publish: async (publication) => { publication.update?.(); return true; },
        });
      },
    } as unknown as ExtensionContext["modelRegistry"];

    await command(scenario.to, { modelRegistry } as ExtensionCommandContext);
    if (scenario.late === "success") finish(oldModels);
    else fail(new Error("old discovery failed"));
    await settled;

    assert.equal(refreshes, 2);
    assert.equal(registrations.length, 2);
    assert.equal(registrations.at(-1)!.name, "Antigravity [pi-agy-bridge]");
    assert.equal(registrations.at(-1)!.getModels()[0]?.id, "gemini-3.8-flash");
    assert.equal(stalePublications, 0);
  });
}

for (const from of ["cli", "acp"] as const) {
  test(`switch from ${from} loads models without an external registry`, async (t) => {
    let provider!: Provider;
    const pi = {
      on: () => {}, registerCommand: () => {},
      registerProvider: (registered: Provider) => { provider = registered; },
    } as unknown as ExtensionAPI;
    await mockDriverSwitchExecutables(t);
    const bridge = new Bridge(pi, from === "cli" ? new CliDriver() : new AcpDriver());
    t.after(() => bridge.liveSessions.disposeAll());
    bridge.start();
    const target = from === "acp" ? "cli" : "acp";

    await bridge.switchDriver(target);

    assert.equal(bridge.driver.id, target);
    assert.equal(provider.getModels()[0]?.id, "gemini-3.8-flash");
    assert.equal(provider.auth!.oauth!.name, "Antigravity");
  });
}

for (const outcome of ["success", "failure"] as const) {
  test(`model refresh remains available after ${outcome} login`, async (t) => {
    let provider!: Provider;
    const pi = {
      on: () => {}, registerCommand: () => {},
      registerProvider: (registered: Provider) => { provider = registered; },
    } as unknown as ExtensionAPI;
    const bridge = new Bridge(pi, new CliDriver());
    t.after(() => bridge.liveSessions.disposeAll());
    bridge.start();
    t.mock.method(bridge.driver.authentication, "login", async () => {
      if (outcome === "failure") throw new Error("synthetic login failure");
    });
    const discovery = t.mock.method(bridge.driver, "discoverModels", async () => parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)"));
    const login = Promise.resolve(provider.auth!.oauth!.login({
      signal: new AbortController().signal, notify: () => {}, prompt: async () => "",
    }));
    if (outcome === "failure") await assert.rejects(login, /synthetic login failure/);
    else await login;

    await provider.refreshModels!({
      allowNetwork: true, signal: new AbortController().signal,
      publish: async (publication) => { publication.update?.(); return true; },
    });

    assert.equal(discovery.mock.callCount(), 1);
    assert.equal(provider.getModels()[0]?.id, "gemini-3.8-flash");
  });
}

test("shutdown during driver disposal cannot register a new provider", async (t) => {
  useExecutable(t, process.execPath);
  t.mock.method(AcpDriver.prototype, "discoverModels", async () => []);
  let shutdown!: () => Promise<void>;
  let registrations = 0;
  const bridge = new Bridge({
    on: (event: string, handler: () => Promise<void>) => { if (event === "session_shutdown") shutdown = handler; },
    registerCommand: () => {}, registerProvider: () => { registrations++; },
  } as unknown as ExtensionAPI, new CliDriver());
  bridge.start();
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  t.after(resume);
  let entered!: () => void;
  const disposing = new Promise<void>((resolve) => { entered = resolve; });
  let disposals = 0;
  t.mock.method(bridge.liveSessions, "disposeAll", async () => {
    if (++disposals === 1) {
      entered();
      await gate;
    }
  });
  const switching = bridge.switchDriver("acp");
  const rejected = assert.rejects(switching, /bridge session ended/);

  await disposing;
  await shutdown();
  resume();
  await rejected;

  assert.equal(registrations, 1);
  assert.equal(bridge.driver.id, "cli");
  await assert.rejects(bridge.switchDriver("acp"), /bridge session ended/);
});

test("driver switch replaces models in the native Pi registry", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agy-driver-switch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authPath = path.join(directory, "auth.json");
  await writeFile(authPath, JSON.stringify({ agy: { type: "api_key", env: { AGY_BRIDGE_ENABLED: "1" } } }));
  const runtime = await ModelRuntime.create({ modelsPath: path.join(directory, "models.json"), authPath, refreshOnCreate: false });
  const pi = {
    on: () => {}, registerCommand: () => {},
    registerProvider: runtime.registerNativeProvider.bind(runtime),
  } as unknown as ExtensionAPI;
  await mockDriverSwitchExecutables(t);
  const bridge = new Bridge(pi);
  t.after(() => bridge.liveSessions.disposeAll());
  bridge.start();
  await runtime.refresh({ providers: ["agy"], allowNetwork: false });
  const acpModels = parseModelsOutput("claude-sonnet-4-6  Claude Sonnet 4.6 (Thinking)").map((model) => ({ ...model, agyDriver: "acp" }));
  t.mock.method(bridge.driver, "discoverModels", async () => acpModels);
  await runtime.refresh({ providers: ["agy"], allowNetwork: true });
  assert.ok(runtime.getModel("agy", "claude-sonnet-4-6"));
  const modelRegistry = {
    refresh: async (options: Parameters<ModelRuntime["refresh"]>[0]) => {
      assert.equal(options?.allowNetwork, false);
      return runtime.refresh(options);
    },
  } as unknown as ExtensionContext["modelRegistry"];

  await bridge.switchDriver("cli", modelRegistry);

  assert.equal(runtime.getModel("agy", "claude-sonnet-4-6"), undefined);
  assert.ok(runtime.getModel("agy", "gemini-3.8-flash"));
});

for (const scenario of [
  { outcome: "success", returnToCli: false },
  { outcome: "failure", returnToCli: false },
  { outcome: "success", returnToCli: true },
  { outcome: "failure", returnToCli: true },
] as const) {
  test(`late ${scenario.outcome} registry refresh cannot publish an obsolete report, return to CLI=${scenario.returnToCli}`, async (t) => {
    const handlers = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
    const messages: { customType: string; content: string }[] = [];
    const pi = {
      on: () => {}, sendMessage: (message: { customType: string; content: string }) => messages.push(message),
      registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => handlers.set(name, options.handler),
      registerProvider: () => {},
    } as unknown as ExtensionAPI;
    const detections = new WeakSet<object>();
    for (const Driver of [CliDriver, AcpDriver]) {
      t.mock.method(Driver.prototype, "detectExecutable", function (this: AcpDriver | CliDriver) {
        if (detections.has(this)) return undefined;
        detections.add(this);
        return "/mock/driver";
      });
      t.mock.method(Driver.prototype, "discoverModels", async () => []);
      t.mock.method(Driver.prototype, "usage", async () => undefined);
    }
    t.mock.method(AgyAuthentication.prototype, "detect", async () => undefined);
    const bridge = new Bridge(pi, new AcpDriver());
    t.after(() => bridge.liveSessions.disposeAll());
    bridge.start();
    const command = handlers.get("agy-bridge:driver")!;
    let release!: (error?: Error) => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve, reject) => { release = (error) => error ? reject(error) : resolve(); });
    let first = true;
    const modelRegistry = { refresh: async () => {
      if (first) { first = false; entered(); await gate; }
    } };
    const setStatus = t.mock.fn();
    const context = { hasUI: true, ui: { setStatus }, modelRegistry } as unknown as ExtensionCommandContext;
    let stale: Promise<void> | undefined;
    t.after(async () => { release(); await stale; });

    stale = command("cli", context);
    await waiting;
    await command("acp", context);
    if (scenario.returnToCli) await command("cli", context);
    const latestReports = messages.filter((message) => message.customType === "pi-agy-bridge:doctor");
    assert.equal(latestReports.length, scenario.returnToCli ? 2 : 1);
    assert.match(latestReports.at(-1)!.content, scenario.returnToCli ? /Antigravity CLI/ : /Antigravity ACP/);
    messages.length = 0;

    release(scenario.outcome === "failure" ? new Error("late registry failure") : undefined);
    await stale;
    assert.equal(messages.length, 0, "superseded completion must not publish diagnostics, warnings, or failures");
    assert.equal(bridge.driver.id, scenario.returnToCli ? "cli" : "acp");
    assert.deepEqual(setStatus.mock.calls.at(-1)?.arguments, ["agy-bridge", undefined]);
  });
}
