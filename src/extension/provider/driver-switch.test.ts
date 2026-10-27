import { CliDriver } from "../drivers/cli/driver.ts";
import { AcpDriver } from "../drivers/acp/driver.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { AcpConnection } from "../drivers/acp/connection.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { parseModelsOutput } from "../discovery/models.ts";
import { Bridge } from "./provider.ts";

async function mockExecutables(t: TestContext) {
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
  t.mock.method(AcpDriver.prototype, "detectExecutable", () => process.execPath);
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
    await mockExecutables(t);
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

    assert.equal(refreshes, 1);
    assert.equal(registrations.length, 2);
    assert.equal(registrations.at(-1)!.name, `${bridge.driver.label} [pi-agy-bridge]`);
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
    await mockExecutables(t);
    const bridge = new Bridge(pi, from === "cli" ? new CliDriver() : new AcpDriver());
    t.after(() => bridge.liveSessions.disposeAll());
    bridge.start();
    const target = from === "acp" ? "cli" : "acp";

    await bridge.switchDriver(target);

    assert.equal(bridge.driver.id, target);
    assert.equal(provider.getModels()[0]?.id, "gemini-3.8-flash");
    assert.equal(provider.auth!.oauth!.name, bridge.driver.label);
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
  t.mock.method(AcpDriver.prototype, "detectExecutable", () => process.execPath);
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
  await mockExecutables(t);
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
