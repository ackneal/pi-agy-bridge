import assert from "node:assert/strict";
import test from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { AcpConnection } from "../drivers/acp/connection.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { parseModelsOutput } from "../discovery/models.ts";
import { AgyBridge } from "./provider.ts";

for (const driver of ["cli", "acp"] as const) {
  for (const tag of [undefined, "cli", "acp"] as const) {
    test(`${driver} restores model cache with ${tag ?? "no"} driver tag`, async () => {
      let provider!: Provider;
      const bridge = new AgyBridge({
        on: () => {}, registerCommand: () => {},
        registerProvider: (registered: Provider) => { provider = registered; },
      } as unknown as ExtensionAPI, { driver });
      bridge.start();
      const models = parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)")
        .map((model) => tag === undefined ? model : { ...model, agyDriver: tag });

      await provider.refreshModels!({
        stored: { models }, allowNetwork: false, signal: new AbortController().signal,
        publish: async (publication) => { publication.update?.(); return true; },
      });

      assert.equal(provider.getModels()[0]?.id, "gemini-3.8-flash");
      assert.equal(bridge.driver.id, driver);
    });
  }
}

test("new ACP session restores a legacy cached scoped model without network or login", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agy-legacy-scope-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authPath = path.join(directory, "auth.json");
  await writeFile(authPath, JSON.stringify({ agy: { type: "api_key", env: { AGY_BRIDGE_ENABLED: "1" } } }));
  const options = { authPath, modelsPath: path.join(directory, "models.json"), refreshOnCreate: false };
  const runtime = await ModelRuntime.create(options);
  const bridge = new AgyBridge({
    on: () => {}, registerCommand: () => {},
    registerProvider: runtime.registerNativeProvider.bind(runtime),
  } as unknown as ExtensionAPI, { driver: "cli" });
  bridge.start();
  await runtime.refresh({ providers: ["agy"], allowNetwork: false });
  t.mock.method(bridge.driver, "discoverModels", async () => parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)"));
  await runtime.refresh({ providers: ["agy"], allowNetwork: true });

  const reopened = await ModelRuntime.create(options);
  const acpBridge = new AgyBridge({
    on: () => {}, registerCommand: () => {},
    registerProvider: reopened.registerNativeProvider.bind(reopened),
  } as unknown as ExtensionAPI, { driver: "acp" });
  const discovery = t.mock.method(acpBridge.driver, "discoverModels", async () => { throw new Error("Offline restore must not discover models"); });
  acpBridge.start();
  await reopened.refresh({ providers: ["agy"], allowNetwork: false });

  assert.ok(reopened.getModel("agy", "gemini-3.8-flash"));
  assert.equal(discovery.mock.callCount(), 0);
  assert.equal(acpBridge.driver.id, "acp");
});

for (const allowNetwork of [false, true]) {
  test(`ACP scoped models remain available without cache or login: network=${allowNetwork}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-noauth-scope-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const authPath = path.join(directory, "auth.json");
    await writeFile(authPath, JSON.stringify({ agy: { type: "api_key", env: { AGY_BRIDGE_ENABLED: "1" } } }));
    const runtime = await ModelRuntime.create({ authPath, modelsPath: path.join(directory, "models.json"), refreshOnCreate: false });
    const start = t.mock.method(AcpConnection.prototype, "start", async () => ({ protocolVersion: acp.PROTOCOL_VERSION }));
    t.mock.method(AcpConnection.prototype, "request", async () => { throw acp.RequestError.authRequired(); });
    const bridge = new AgyBridge({
      on: () => {}, registerCommand: () => {},
      registerProvider: runtime.registerNativeProvider.bind(runtime),
    } as unknown as ExtensionAPI, { acpPath: process.execPath, agyPath: process.execPath, acpCwd: directory });
    bridge.start();
    await runtime.refresh({ providers: ["agy"], allowNetwork: false });

    await runtime.refresh({ providers: ["agy"], allowNetwork });

    assert.equal(bridge.driver.id, "acp");
    assert.ok(runtime.getModel("agy", "gemini-3.8-flash"));
    assert.ok(runtime.getModel("agy", "gemini-3.1-pro"));
    assert.equal(start.mock.callCount(), allowNetwork ? 1 : 0);
  });
}
