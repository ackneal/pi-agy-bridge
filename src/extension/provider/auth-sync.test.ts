import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { Credential } from "@earendil-works/pi-ai";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { AgyAuthentication, createAgyBridgeCredential } from "./auth.ts";
import { synchronizeAgyAuthentication } from "./auth-sync.ts";

const signal = new AbortController().signal;
const unrelated = { type: "api_key", key: "unrelated" };

async function fixture(t: TestContext, original?: Credential) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agy-auth-sync-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authPath = path.join(directory, "auth.json");
  await writeFile(authPath, JSON.stringify({ ...(original ? { agy: original } : {}), unrelated }));
  const authentication = new AgyAuthentication({
    label: "Fixture",
    probe: async () => { throw new Error("must not probe"); },
    login: async () => { throw new Error("must not log in to backend"); },
  }, async () => {}, "cli");
  t.after(() => authentication.close());
  return { directory, authPath, authentication };
}

for (const driver of ["cli", "acp"] as const) {
  for (const status of ["authenticated", "unauthenticated", "unknown"] as const) {
    for (const kind of ["absent", "legacy", "untagged", "matching", "historical", "other driver", "custom", "user oauth"] as const) {
      test(`${driver} synchronization: ${status}, ${kind}`, async (t) => {
        const original: Credential | undefined = kind === "absent" ? undefined
          : kind === "custom" ? { type: "api_key", key: "custom" }
          : kind === "user oauth" ? { type: "oauth", access: "user-token", refresh: "refresh-token", expires: Date.now() + 10000 }
          : kind === "legacy" ? { type: "api_key", env: { AGY_BRIDGE_ENABLED: "1", AGY_BRIDGE_LOGIN_EPOCH: "old" } }
          : createAgyBridgeCredential(kind === "untagged" ? undefined : kind === "other driver" ? driver === "cli" ? "acp" : "cli" : driver);
        if (kind === "historical" && original?.type === "oauth") original.loginEpoch = "old";
        const f = await fixture(t, original);
        f.authentication.setBackend({ label: "Fixture", probe: async () => true, login: async () => { throw new Error("must not log in to backend"); } }, driver);
        f.authentication.status = status;
        const before = await readFile(f.authPath, "utf8");
        const login = t.mock.method(ModelRuntime.prototype, "login");
        const logout = t.mock.method(ModelRuntime.prototype, "logout");
        const managed = kind !== "custom" && kind !== "user oauth";
        const initialize = status === "authenticated" && managed && ["absent", "legacy", "other driver"].includes(kind);
        const remove = status === "unauthenticated" && managed && original !== undefined;

        await synchronizeAgyAuthentication(f.authentication, driver, f.authPath, signal, original);
        const result = readStoredCredential("agy", f.authPath);
        await synchronizeAgyAuthentication(f.authentication, driver, f.authPath, signal, result);

        assert.equal(login.mock.callCount(), initialize ? 1 : 0);
        assert.equal(logout.mock.callCount(), remove ? 1 : 0);
        if (initialize) {
          assert.equal(result?.type, "oauth");
          assert.equal(result?.driver, driver);
          assert.equal(result?.loginEpoch, undefined);
        } else if (remove) assert.equal(result, undefined);
        else {
          assert.deepEqual(result, original);
          assert.equal(await readFile(f.authPath, "utf8"), before, "consistent state must not write");
        }
        assert.deepEqual(JSON.parse(await readFile(f.authPath, "utf8")).unrelated, unrelated);
      });
    }
  }
}

for (const status of ["authenticated", "unauthenticated"] as const) {
  for (const current of [undefined, createAgyBridgeCredential("acp"), { type: "api_key", key: "user" } satisfies Credential]) {
    test(`${status} preserves external credential replacement ${current?.type ?? "logout"}`, async (t) => {
      const original = createAgyBridgeCredential("cli");
      const f = await fixture(t, original);
      f.authentication.status = status;
      await writeFile(f.authPath, JSON.stringify(current ? { agy: current } : {}));
      const before = await readFile(f.authPath, "utf8");
      const login = t.mock.method(ModelRuntime.prototype, "login");
      const logout = t.mock.method(ModelRuntime.prototype, "logout");

      await synchronizeAgyAuthentication(f.authentication, "cli", f.authPath, signal, original);

      assert.equal(login.mock.callCount(), 0);
      assert.equal(logout.mock.callCount(), 0);
      assert.equal(await readFile(f.authPath, "utf8"), before);
    });
  }
}

for (const stage of ["runtime creation", "auth conversion"] as const) {
  test(`preserves a credential changed during ${stage}`, async (t) => {
    const original = createAgyBridgeCredential("acp");
    const current: Credential = { type: "api_key", key: "user" };
    const f = await fixture(t, original);
    f.authentication.status = "authenticated";
    if (stage === "runtime creation") {
      const create = ModelRuntime.create;
      t.mock.method(ModelRuntime, "create", async (...args: Parameters<typeof ModelRuntime.create>) => {
        const runtime = await create(...args);
        await writeFile(f.authPath, JSON.stringify({ agy: current }));
        return runtime;
      });
    } else {
      const toAuth = f.authentication.oauth.toAuth;
      t.mock.method(f.authentication.oauth, "toAuth", async (...args: Parameters<typeof toAuth>) => {
        await writeFile(f.authPath, JSON.stringify({ agy: current }));
        return toAuth(...args);
      });
    }

    const operation = synchronizeAgyAuthentication(f.authentication, "cli", f.authPath, signal, original);
    if (stage === "auth conversion") await assert.rejects(operation, /superseded/);
    else await operation;

    assert.deepEqual(readStoredCredential("agy", f.authPath), current);
  });
}

test("first initialization uses Pi to create credential storage", async (t) => {
  const f = await fixture(t);
  f.authentication.status = "authenticated";
  const authPath = path.join(f.directory, "new", "auth.json");

  await synchronizeAgyAuthentication(f.authentication, "cli", authPath, signal, undefined);

  const credential = readStoredCredential("agy", authPath);
  assert.equal(credential?.type, "oauth");
  assert.equal(credential.driver, "cli");
});

test("aborted synchronization does not mutate credentials", async (t) => {
  const original = createAgyBridgeCredential("acp");
  const f = await fixture(t, original);
  f.authentication.status = "authenticated";
  const controller = new AbortController();
  controller.abort(new Error("fixture cancellation"));

  await assert.rejects(synchronizeAgyAuthentication(f.authentication, "cli", f.authPath, controller.signal, original), /fixture cancellation/);

  assert.deepEqual(readStoredCredential("agy", f.authPath), original);
});

test("two local Pi processes preserve shared credentials and stale snapshots", async (t) => {
  const f = await fixture(t);
  const source = `
    import { readFile } from 'node:fs/promises';
    import assert from 'node:assert/strict';
    import { AgyAuthentication } from ${JSON.stringify(new URL("./auth.ts", import.meta.url).href)};
    import { synchronizeAgyAuthentication } from ${JSON.stringify(new URL("./auth-sync.ts", import.meta.url).href)};
    const [authPath, driver] = process.argv.slice(1);
    const auth = new AgyAuthentication({ label: 'Fixture', probe: async () => true, login: async () => { throw new Error('backend login'); } }, async () => {}, driver);
    auth.status = 'authenticated';
    const before = await readFile(authPath, 'utf8');
    await synchronizeAgyAuthentication(auth, driver, authPath, new AbortController().signal, undefined);
    if (driver === 'acp') assert.equal(await readFile(authPath, 'utf8'), before);
    auth.close();
  `;
  const run = promisify(execFile);

  await run(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", source, f.authPath, "cli"]);
  const first = await readFile(f.authPath, "utf8");
  await run(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", source, f.authPath, "acp"]);

  assert.equal(await readFile(f.authPath, "utf8"), first);
  const credential = readStoredCredential("agy", f.authPath);
  assert.equal(credential?.type, "oauth");
  assert.equal(credential.driver, "cli");
});
