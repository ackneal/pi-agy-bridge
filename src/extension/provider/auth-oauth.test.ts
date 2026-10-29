import type { DriverAuthentication } from "../drivers/types.ts";
import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { AgyAuthentication, createAgyBridgeCredential, getAgyBridgeAuthEnvironment, isAgyBridgeEnabled } from "./auth.ts";

const noProbeBackend: DriverAuthentication = {
  label: "Antigravity CLI",
  probe: async () => { throw new Error("Unexpected authentication probe"); },
  login: async () => { throw new Error("Unexpected authentication login"); },
};

test("local OAuth renewal and validation uses the constant bridge key", async (t) => {
    const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("Unexpected subprocess"); });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
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

for (const marker of [undefined, "secret", "agy-bridge:", "agy-bridge:%", "agy-bridge:%20"]) {
  test(`reject invalid bridge API key ${marker}`, () => {
    assert.equal(getAgyBridgeAuthEnvironment(marker), undefined);
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
