import assert from "node:assert/strict";
import test from "node:test";
import { AgyAuthentication, createAgyBridgeCredential, isAgyBridgeEnabled } from "./auth.ts";
import type { DriverId } from "../drivers/types.ts";

for (const driver of ["cli", "acp"] as const) {
  for (const recorded of [undefined, "cli", "acp"] as const) {
    test(`${driver} credential resolution with ${recorded ?? "legacy"} marker`, async () => {
      const auth = new AgyAuthentication({ label: "Fixture", probe: async () => true, login: async () => {} }, async () => {}, driver);
      const credential = createAgyBridgeCredential("fixture", recorded);
      const allowed = recorded === undefined || recorded === driver;
      assert.equal(isAgyBridgeEnabled(credential, driver), allowed);
      if (allowed) assert.deepEqual(await auth.oauth.toAuth(credential), { apiKey: "agy-bridge:fixture" });
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
      assert.notEqual(first.loginEpoch, second.loginEpoch);
      await assert.rejects(auth.oauth.toAuth(first), /Invalid/);
    } finally {
      auth.close();
    }
  });
}
