import { CliDriver } from "../drivers/cli/driver.ts";
import { AcpDriver } from "../drivers/acp/driver.ts";
import assert from "node:assert/strict";
import test from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { AcpConnection } from "../drivers/acp/connection.ts";
import { parseModelsOutput } from "../discovery/models.ts";
import { Bridge } from "./provider.ts";

for (const failure of ["missing executable", "initialization", "session", "authentication"] as const) {
  test(`default ACP never falls back to installed CLI after ${failure} failure`, async (t) => {
    let provider!: Provider;
    const bridge = new Bridge({
      on: () => {}, registerCommand: () => {},
      registerProvider: (registered: Provider) => { provider = registered; },
    } as unknown as ExtensionAPI, new AcpDriver());
    t.mock.method(AcpDriver.prototype, "detectExecutable", () => failure === "missing executable" ? undefined : process.execPath);
    const start = t.mock.method(AcpConnection.prototype, "start", async () => {
      if (failure === "initialization") throw new Error("synthetic initialization failure");
      return { protocolVersion: acp.PROTOCOL_VERSION };
    });
    t.mock.method(AcpConnection.prototype, "request", async () => {
      if (failure === "authentication") throw acp.RequestError.authRequired();
      throw new Error("synthetic session failure");
    });
    bridge.start();

    await provider.refreshModels!({
      allowNetwork: true, signal: new AbortController().signal,
      publish: async (publication) => { publication.update?.(); return true; },
    });

    assert.equal(bridge.driver.id, "acp");
    assert.equal(provider.auth!.oauth!.name, "Antigravity ACP");
    assert.ok(provider.getModels().some((model) => model.id === "gemini-3.8-flash"));
    assert.equal(start.mock.callCount(), failure === "missing executable" ? 0 : 1);
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
  assert.equal(providers[1]?.name, "Antigravity CLI [pi-agy-bridge]");
  assert.equal(providers[2]?.name, "Antigravity ACP [pi-agy-bridge]");
});
