import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { AgyAuthentication, createAgyBridgeCredential, getAgyBridgeAuthEnvironment, isAgyBridgeEnabled } from "./auth.ts";

for (const epoch of ["test epoch", "a/b:%", "123"]) {
  test(`local OAuth renewal and marker: ${epoch}`, async (t) => {
    const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("Unexpected subprocess"); });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const auth = new AgyAuthentication("/must-not-spawn", async () => {});
    t.after(() => auth.close());
    const credential = { ...createAgyBridgeCredential(epoch), expires: 0 };
    const refreshed = await auth.oauth.refresh(credential, new AbortController().signal);
    assert.deepEqual(refreshed, { ...credential, expires: refreshed.expires });
    assert.ok(refreshed.expires > Date.now());
    assert.equal(isAgyBridgeEnabled(refreshed), true);
    assert.deepEqual(await auth.oauth.toAuth(refreshed), { apiKey: `agy-bridge:${encodeURIComponent(epoch)}` });
    assert.deepEqual(getAgyBridgeAuthEnvironment((await auth.oauth.toAuth(refreshed)).apiKey), {
      AGY_BRIDGE_ENABLED: "1", AGY_BRIDGE_LOGIN_EPOCH: epoch,
    });
    assert.equal(auth.method.login, undefined);
    assert.equal(auth.oauth.isSubscription, true);
    assert.equal(spawn.mock.callCount(), 0);
  });
}

for (const marker of [undefined, "secret", "agy-bridge:", "agy-bridge:%", "agy-bridge:%20"]) {
  test(`reject invalid marker ${marker}`, () => {
    assert.equal(getAgyBridgeAuthEnvironment(marker), undefined);
  });
}

for (const patch of [{ agyBridge: false }, { loginEpoch: "" }, { access: "secret" }, { refresh: "secret" }]) {
  test(`reject invalid credential ${JSON.stringify(patch)}`, async (t) => {
    const auth = new AgyAuthentication(undefined, async () => {});
    t.after(() => auth.close());
    const credential = { ...createAgyBridgeCredential(), ...patch };
    assert.equal(isAgyBridgeEnabled(credential), false);
    await assert.rejects(auth.oauth.toAuth(credential), /Invalid Antigravity CLI bridge credentials/);
    await assert.rejects(auth.oauth.refresh(credential, new AbortController().signal), /Invalid Antigravity CLI bridge credentials/);
  });
}
