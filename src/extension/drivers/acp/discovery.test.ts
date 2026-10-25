import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { AcpConnection } from "./connection.ts";
import { modelDefaults } from "../../discovery/model-metadata.ts";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { discoverAcpModels, newDiscoverySession, withAcpDiscovery } from "./discovery.ts";

for (const mode of ["catalog", "missing", "empty", "required", "failure", "hang", "cancel"]) {
  test(`ACP discovery ${mode}`, async () => {
    const options = { executable: process.execPath, cwd: process.cwd(), args: ["--experimental-strip-types", fileURLToPath(new URL("./discovery-fixture.ts", import.meta.url)), mode === "cancel" ? "hang" : mode], requestTimeoutMs: 1500 };
    const start = Date.now();
    if (mode === "catalog") {
      const models = await discoverAcpModels(options);
      assert.equal(models[0]?.id, "novel");
      assert.equal(models[0]?.thinkingLevelMap?.high, "high");
      assert.equal(models[0]?.thinkingLevelMap?.low, null);
    } else if (mode === "required") {
      const models = await discoverAcpModels(options);
      assert.ok(models.some(({ id }) => id === "gemini-3.8-flash"));
      assert.ok(models.some(({ id }) => id === "gemini-3.1-pro"));
      for (const model of models) {
        assert.equal(model.contextWindow, modelDefaults(model.id).contextWindow);
        assert.deepEqual(model.cost, modelDefaults(model.id).cost);
      }
      await assert.rejects(withAcpDiscovery(options, undefined,
        (connection) => newDiscoverySession(connection, options.cwd)),
      (error: unknown) => error instanceof acp.RequestError && error.code === -32000);
    } else {
      await assert.rejects(discoverAcpModels(options, mode === "cancel" ? AbortSignal.timeout(600) : undefined),
        mode === "missing" ? /configuration/ : mode === "empty" ? /empty/ : mode === "failure" ? /synthetic failure/ : /timeout|disposed|aborted/i);
    }
    assert.ok(Date.now() - start < 4000, "bounded cleanup");
  });
}

for (const grouped of [false, true]) {
  test(`ACP discovery preserves server-advertised Claude models (${grouped ? "grouped" : "flat"})`, async (t) => {
    const values = [
      { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    ];
    t.mock.method(AcpConnection.prototype, "start", async () => ({ protocolVersion: acp.PROTOCOL_VERSION }));
    t.mock.method(AcpConnection.prototype, "dispose", async () => {});
    t.mock.method(AcpConnection.prototype, "request", async () => ({
      sessionId: "synthetic", configOptions: [{ id: "model", name: "Model", type: "select", currentValue: values[0]!.value,
        options: grouped ? [{ group: "available", name: "Available models", options: values }] : values }],
    }));
    const models = await discoverAcpModels({ executable: "unused", cwd: process.cwd() });
    assert.deepEqual(models.map(({ id, name }) => ({ id, name })), values.map(({ value, name }) => ({ id: value, name })));
  });
}

for (const scenario of [
  { name: "SDK auth-required", error: acp.RequestError.authRequired(), fallback: true },
  { name: "message alone", error: new acp.RequestError(-32603, "Authentication required"), fallback: false },
  { name: "generic error", error: new Error("Authentication required"), fallback: false },
  { name: "disconnection", error: new Error("ACP transport closed"), fallback: false },
  { name: "initialization auth-required", error: acp.RequestError.authRequired(), fallback: false, initialize: true },
  { name: "cancelled auth-required", error: acp.RequestError.authRequired(), fallback: false, cancel: true },
]) {
  test(`ACP discovery classification: ${scenario.name}`, async (t) => {
    const controller = new AbortController();
    t.mock.method(AcpConnection.prototype, "start", async () => {
      if (scenario.initialize) throw scenario.error;
      return { protocolVersion: acp.PROTOCOL_VERSION };
    });
    t.mock.method(AcpConnection.prototype, "dispose", async () => {});
    const request = t.mock.method(AcpConnection.prototype, "request", async (method: acp.AgentRequestMethod, params: acp.AgentRequestParamsByMethod[acp.AgentRequestMethod]) => {
      assert.equal(method, acp.methods.agent.session.new);
      assert.deepEqual(params, { cwd: process.cwd(), mcpServers: [], _meta: { antigravity: { enabledTools: [] } } });
      if (scenario.cancel) controller.abort(new Error("cancelled"));
      throw scenario.error;
    });
    const result = discoverAcpModels({ executable: "unused", cwd: process.cwd() }, controller.signal);
    if (scenario.fallback) assert.ok((await result).length > 0);
    else await assert.rejects(result, (error) => error === (scenario.cancel ? controller.signal.reason : scenario.error));
    assert.equal(request.mock.callCount(), scenario.initialize ? 0 : 1);
  });
}
