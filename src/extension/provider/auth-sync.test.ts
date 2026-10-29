import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, stat, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import lockfile from "proper-lockfile";
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

async function fixture(t: TestContext, content: string | undefined) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agy-auth-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authPath = path.join(directory, "auth.json");
  if (content !== undefined) await writeFile(authPath, content);
  const authentication = new AgyAuthentication({
    label: "Fixture",
    probe: async () => { throw new Error("must not probe"); },
    login: async () => { throw new Error("must not log in"); },
  }, async () => {}, "cli");
  t.after(() => authentication.close());
  authentication.status = "authenticated";
  return { directory, authPath, authentication };
}

function observeLockAttempt(t: TestContext): Promise<void> {
  let attempted!: () => void;
  const observed = new Promise<void>((resolve) => { attempted = resolve; });
  const lock = lockfile.lock;
  t.mock.method(lockfile, "lock", (...args: Parameters<typeof lockfile.lock>) => {
    attempted();
    return lock(...args);
  });
  return observed;
}

const oldCredential = createAgyBridgeCredential("old", "cli");
const newCredential = createAgyBridgeCredential("new", "acp");
for (const row of [
  { name: "unauthenticated preserves newer login", status: "unauthenticated", original: oldCredential, current: newCredential, expected: "preserved" },
  { name: "authenticated preserves newer login", status: "authenticated", original: oldCredential, current: newCredential, expected: "preserved" },
  { name: "authenticated preserves logout", status: "authenticated", original: oldCredential, current: undefined, expected: "preserved" },
  { name: "absent original preserves newer login", status: "authenticated", original: undefined, current: newCredential, expected: "preserved" },
  { name: "unchanged credential can be deleted", status: "unauthenticated", original: oldCredential, current: oldCredential, expected: "removed" },
  { name: "unchanged credential can be renewed", status: "authenticated", original: oldCredential, current: oldCredential, expected: "renewed" },
] as const) {
  test(`credential lock gate: ${row.name}`, async (t) => {
    const f = await fixture(t, JSON.stringify(row.original ? { agy: row.original } : {}));
    f.authentication.status = row.status;
    let release: (() => Promise<void>) | undefined = await lockfile.lock(f.authPath, { realpath: false, stale: 30_000, retries: 0 });
    t.after(async () => { if (release) await release(); });
    const attempted = observeLockAttempt(t);

    const sync = synchronizeAgyAuthentication(f.authentication, "cli", f.authPath, new AbortController().signal, row.original);
    await Promise.race([attempted, sync.then(() => { throw new Error("Synchronization bypassed the held lock"); })]);
    await writeFile(f.authPath, JSON.stringify(row.current ? { agy: row.current } : {}));
    await release();
    release = undefined;
    await sync;

    const result = readStoredCredential("agy", f.authPath);
    if (row.expected === "preserved") assert.deepEqual(result, row.current);
    else if (row.expected === "removed") assert.equal(result, undefined);
    else {
      assert.equal(result?.type, "oauth");
      assert.equal(result?.loginEpoch, "old");
      assert.equal(result?.driver, "cli");
    }
    assert.equal(await lockfile.check(f.authPath, { realpath: false, stale: 30_000 }), false);
  });
}

test("cancellation while waiting does not release the other writer's lock", async (t) => {
  const f = await fixture(t, JSON.stringify({ agy: oldCredential }));
  const release = await lockfile.lock(f.authPath, { realpath: false, stale: 30_000, retries: 0 });
  t.after(async () => { await release(); });
  const attempted = observeLockAttempt(t);
  const controller = new AbortController();

  const sync = synchronizeAgyAuthentication(f.authentication, "cli", f.authPath, controller.signal, oldCredential);
  await Promise.race([attempted, sync.then(() => { throw new Error("Synchronization bypassed the held lock"); })]);
  controller.abort(new Error("fixture cancellation"));
  await assert.rejects(sync, /fixture cancellation/);

  assert.deepEqual(readStoredCredential("agy", f.authPath), oldCredential);
  await assert.rejects(lockfile.lock(f.authPath, { realpath: false, stale: 30_000, retries: 0 }),
    (error: NodeJS.ErrnoException) => error.code === "ELOCKED");
});

for (const content of ["{", "[]", "null"]) {
  test(`invalid auth JSON stays intact and releases the lock: ${content}`, async (t) => {
    const f = await fixture(t, content);

    await assert.rejects(synchronizeAgyAuthentication(f.authentication, "cli", f.authPath, new AbortController().signal, undefined),
      content === "{" ? SyntaxError : /Invalid auth.json/);

    assert.equal(await readFile(f.authPath, "utf8"), content);
    const release = await lockfile.lock(f.authPath, { realpath: false, stale: 30_000, retries: 0 });
    await release();
  });
}

test("BOM input keeps unrelated providers when updating the marker", async (t) => {
  const unrelated = { type: "api_key", key: "unrelated" };
  const f = await fixture(t, `\uFEFF${JSON.stringify({ agy: oldCredential, unrelated })}`);

  await synchronizeAgyAuthentication(f.authentication, "cli", f.authPath, new AbortController().signal, oldCredential);

  const result = JSON.parse(await readFile(f.authPath, "utf8"));
  assert.deepEqual(result.unrelated, unrelated);
  assert.equal(result.agy.loginEpoch, "old");
});

for (const row of [
  { name: "new file", existingMode: undefined, expected: 0o600 },
  { name: "existing file", existingMode: 0o640, expected: 0o640 },
]) {
  test(`credential synchronization preserves permissions: ${row.name}`, async (t) => {
    const f = await fixture(t, row.existingMode === undefined ? undefined : "{}");
    if (row.existingMode !== undefined) await chmod(f.authPath, row.existingMode);
    const authPath = row.existingMode === undefined ? path.join(f.directory, "nested", "auth.json") : f.authPath;

    await synchronizeAgyAuthentication(f.authentication, "cli", authPath, new AbortController().signal, undefined);

    assert.equal((await stat(authPath)).mode & 0o777, row.expected);
    assert.equal(readStoredCredential("agy", authPath)?.type, "oauth");
  });
}

for (const status of ["authenticated", "unauthenticated"] as const) {
  test(`another process's login survives ${status} synchronization`, async (t) => {
    const f = await fixture(t, JSON.stringify({ agy: oldCredential }));
    f.authentication.status = status;
    const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./auth-sync-lock-fixture.ts", import.meta.url)), f.authPath],
      { stdio: ["pipe", "pipe", "inherit"] });
    const closed = once(child, "close");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    });
    let output = "";
    const ready = new Promise<void>((resolve) => child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("locked\n")) resolve();
    }));
    await Promise.race([ready, closed.then(() => { throw new Error("Writer exited before acquiring its lock"); })]);
    const attempted = observeLockAttempt(t);

    const sync = synchronizeAgyAuthentication(f.authentication, "cli", f.authPath, new AbortController().signal, oldCredential);
    await Promise.race([attempted, sync.then(() => { throw new Error("Synchronization bypassed the child writer's lock"); })]);
    child.stdin.end(`${JSON.stringify({ agy: newCredential })}\n`);
    const [code, signal] = await closed;
    await sync;

    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.deepEqual(readStoredCredential("agy", f.authPath), newCredential);
  });
}
