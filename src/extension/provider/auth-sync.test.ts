import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Credential } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { AgyAuthentication, createAgyBridgeCredential } from "./auth.ts";
import { synchronizeAgyAuthentication } from "./auth-sync.ts";

for (const driver of ["cli", "acp"] as const) {
  for (const status of ["authenticated", "unauthenticated", "unknown"] as const) {
    for (const kind of ["absent", "legacy", "untagged", "matching", "other driver", "custom"] as const) {
      test(`${driver} synchronization: ${status}, ${kind}`, async (t) => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "agy-auth-sync-"));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const authPath = path.join(directory, "auth.json");
        const original: Credential | undefined = kind === "absent" ? undefined
          : kind === "custom" ? { type: "api_key", key: "custom" }
          : kind === "legacy" ? { type: "api_key", env: { AGY_BRIDGE_ENABLED: "1", AGY_BRIDGE_LOGIN_EPOCH: "fixture" } }
          : createAgyBridgeCredential("fixture", kind === "untagged" ? undefined : kind === "matching" ? driver : driver === "cli" ? "acp" : "cli");
        const unrelated = { type: "api_key", key: "unrelated" };
        await writeFile(authPath, JSON.stringify({ ...(original ? { agy: original } : {}), unrelated }));
        const authentication = new AgyAuthentication({ label: "Fixture", probe: async () => { throw new Error("must not probe"); }, login: async () => { throw new Error("must not log in"); } }, async () => {}, driver);
        t.after(() => authentication.close());
        authentication.status = status;

        await synchronizeAgyAuthentication(authentication, driver, authPath, new AbortController().signal, original);

        const result = readStoredCredential("agy", authPath);
        if (kind === "custom" || (status === "unknown" && kind !== "other driver")) assert.deepEqual(result, original);
        else if (status === "authenticated") {
          assert.equal(result?.type, "oauth");
          if (result?.type !== "oauth") return;
          assert.equal(result.driver, driver);
          assert.equal(result.agyBridge, true);
          assert.equal(result.access, "");
          assert.equal(result.refresh, "");
          assert.ok(result.loginEpoch);
          if (original) assert.equal(result.loginEpoch, "fixture");
        } else assert.equal(result, undefined);
        assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")).unrelated, unrelated);
      });
    }
  }
}

for (const scenario of ["aborted", "changed", "logged out"] as const) {
  test(`authentication synchronization skips ${scenario} result`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-auth-sync-race-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const authPath = path.join(directory, "auth.json");
    const original = createAgyBridgeCredential("old", "cli");
    const current = scenario === "logged out" ? undefined : createAgyBridgeCredential("new", "acp");
    await writeFile(authPath, JSON.stringify(current ? { agy: current } : {}));
    const authentication = new AgyAuthentication({ label: "Fixture", probe: async () => true, login: async () => {} }, async () => {}, "cli");
    t.after(() => authentication.close());
    authentication.status = "authenticated";
    const controller = new AbortController();
    if (scenario === "aborted") controller.abort(new Error("fixture cancellation"));

    const sync = synchronizeAgyAuthentication(authentication, "cli", authPath, controller.signal, original);
    if (scenario === "aborted") await assert.rejects(sync, /fixture cancellation/);
    else await sync;
    assert.deepEqual(readStoredCredential("agy", authPath), current);
  });
}
