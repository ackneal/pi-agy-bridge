import { beforeEach } from "node:test";
import { useAuthHomeFixture } from "./auth-home-fixture.ts";
import { Driver as CliDriver } from "../drivers/cli/driver.ts";
import { Driver as AcpDriver } from "../drivers/acp/driver.ts";
import { useAcpExecutable } from "../drivers/acp/executable-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { Connection as AcpConnection } from "../drivers/acp/connection.ts";
import { parseModelsOutput } from "../discovery/models.ts";
import { Bridge } from "./provider.ts";

useAuthHomeFixture();

for (const failure of ["installation", "initialization", "session", "authentication"] as const) {
  test(`default ACP never falls back to installed CLI after ${failure} failure`, async (t) => {
    let provider!: Provider;
    const bridge = new Bridge({
      on: () => {}, registerCommand: () => {},
      registerProvider: (registered: Provider) => { provider = registered; },
    } as unknown as ExtensionAPI, new AcpDriver(async () => { throw new Error("synthetic installation failure"); }));
    useAcpExecutable(t, failure === "installation" ? undefined : process.execPath);
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
