import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Credential } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { parseModelsOutput } from "../discovery/models.ts";
import { AgyAuthentication, createAgyBridgeCredential } from "./auth.ts";
import { autoConfigureAgyAuthentication } from "./startup-auth.ts";

const noRequests = {
  stream: () => { throw new Error("network forbidden"); },
  streamSimple: () => { throw new Error("network forbidden"); },
};

const existing = createAgyBridgeCredential("existing");
const legacy: Credential = { type: "api_key", env: { AGY_BRIDGE_ENABLED: "1", AGY_BRIDGE_LOGIN_EPOCH: "legacy-epoch" } };
const other: Credential = { type: "api_key", key: "other" };

for (const scenario of [
  { name: "persists detection", probes: 1, saved: true },
  { name: "false does not save", probes: 1, false: true },
  { name: "error propagates without saving", probes: 1, error: true },
  { name: "existing marker skips detection unchanged", initial: existing, probes: 0 },
  { name: "other credential is untouched", initial: other, probes: 0 },
  { name: "legacy upgrades preserving epoch", initial: legacy, probes: 0, saved: true },
  { name: "legacy without epoch generates one", initial: { type: "api_key", env: { AGY_BRIDGE_ENABLED: "1" } } satisfies Credential, probes: 0, saved: true, generated: true },
  { name: "legacy empty epoch generates one", initial: { type: "api_key", env: { AGY_BRIDGE_ENABLED: "1", AGY_BRIDGE_LOGIN_EPOCH: "" } } satisfies Credential, probes: 0, saved: true, generated: true },
  { name: "changed credential wins", probes: 1, changed: true },
  { name: "abort prevents persistence", probes: 1, abort: true },
  { name: "shutdown prevents persistence", probes: 1, close: true },
]) {
  test(`startup auth configuration: ${scenario.name}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-startup-configuration-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const authPath = path.join(directory, "auth.json");
    const controller = new AbortController();
    const authentication = new AgyAuthentication(undefined, async () => { throw new Error("real login forbidden"); });
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
    const models = parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)");
    runtime.registerNativeProvider({ ...noRequests, id: "agy", name: "AGY", getModels: () => models, auth: { oauth: authentication.oauth } });
    const registry = new ModelRegistry(runtime);
    const interaction = { signal: controller.signal, notify: () => {}, prompt: async () => { throw new Error("prompt forbidden"); } };
    const store = async (credential: Credential) => {
      const writer = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
      writer.registerNativeProvider({ ...noRequests, id: "agy", name: "AGY", getModels: () => [], auth: {
        ...(credential.type === "oauth"
          ? { oauth: { ...authentication.oauth, login: async () => credential } }
          : { apiKey: { name: "test", login: async () => credential, resolve: async () => undefined } }),
      } });
      await writer.login("agy", credential.type, interaction);
    };
    if (scenario.initial) await store(scenario.initial);
    await registry.refresh({ providers: ["agy"], allowNetwork: false });
    if (!scenario.initial) assert.equal(registry.getAvailable().length, 0);
    const detected = createAgyBridgeCredential("detected");
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
      if (scenario.generated) assert.match(String(stored?.loginEpoch), /^[0-9a-f-]{36}$/);
      else assert.equal(stored?.loginEpoch, scenario.initial ? "legacy-epoch" : "detected");
      await registry.refresh({ providers: ["agy"], allowNetwork: false });
      assert.equal(registry.getAvailable().length, 1);
      assert.equal(registry.isUsingOAuth(models[0]!), true);
      assert.equal((await runtime.checkAuth("agy"))?.type, "oauth");
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
    const { writeFile } = await import("node:fs/promises");
    const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
    const credentials = new InMemoryCredentialStore();
    if (row.initial) await credentials.modify("agy", async () => row.initial);
    await writeFile(authPath, JSON.stringify(row.initial ? { agy: row.initial } : {}));
    const authentication = new AgyAuthentication(undefined, async () => { throw new Error("login forbidden"); });
    t.after(() => authentication.close());
    t.mock.method(authentication, "detect", async () => createAgyBridgeCredential("detected"));
    const create = ModelRuntime.create.bind(ModelRuntime);
    t.mock.method(ModelRuntime, "create", (options: Parameters<typeof ModelRuntime.create>[0]) => create({ ...options, credentials }));
    const modify = credentials.modify.bind(credentials);
    let commits = 0;
    t.mock.method(credentials, "modify", async (providerId: string, fn: Parameters<typeof credentials.modify>[1], options: Parameters<typeof credentials.modify>[2]) => {
      // Inject after every startup preflight, exactly when login enters mutation.
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
    assert.equal(stored.loginEpoch, row.initial ? "legacy-epoch" : "detected");
  });
}
