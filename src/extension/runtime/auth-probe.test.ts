import assert from "node:assert/strict";
import cp from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { probeAgyAuthentication } from "./auth.ts";
import { AgyAuthenticationRequiredError, type AgyUsage } from "./usage.ts";

const groups = [{
  name: "Pro",
  buckets: [{ id: "pro-5h", name: "Five Hour", window: "5h", remainingFraction: 0.75 }],
}];
const text = "Quota\nPro  Five Hour  75%\n";
const emit = (output: string) => `process.stdout.write(${JSON.stringify(output)});`;
const callbackError = new Error("usage consumer failed");
const callbackAuthError = new AgyAuthenticationRequiredError();

type Row = {
  name: string;
  script?: string;
  result?: boolean;
  error?: RegExp | Error;
  callbackError?: Error;
  aborted?: boolean;
};

const rows: Row[] = [
  { name: "parsed text succeeds and reports usage once", script: emit(text), result: true },
  { name: "unrecognized output throws", script: emit("report unavailable"), error: /returned no quota data/ },
  { name: "nonzero exit with valid quota throws", script: `${emit(text)} process.exitCode = 7;`, error: /process failed \(exit 7\)/ },
  { name: "explicit authentication requirement returns false", script: emit("Authentication required"), result: false },
  { name: "OAuth URL alone is not an authentication verdict", script: emit("Open https://example.test/oauth"), error: /returned no quota data/ },
  { name: "login suggestion alone is not an authentication verdict", script: `${emit("Please run login")} process.exitCode = 1;`, error: /process failed \(exit 1\)/ },
  { name: "authorization code prompt alone is not an authentication verdict", script: emit("Enter authorization code:"), error: /returned no quota data/ },
  { name: "already aborted signal throws without spawning", aborted: true },
  { name: "callback error propagates", script: emit(text), callbackError, error: callbackError },
  { name: "callback authentication error propagates instead of returning false", script: emit(text), callbackError: callbackAuthError, error: callbackAuthError },
];

for (const row of rows) {
  test(`probeAgyAuthentication: ${row.name}`, { timeout: 3000, skip: process.platform === "win32" }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "agy-auth-probe-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = join(directory, "agy");
    await writeFile(executable, `#!${process.execPath}\n${row.script ?? ""}\n`, { mode: 0o755 });

    const controller = new AbortController();
    const abortReason = new Error("probe already cancelled");
    if (row.aborted) controller.abort(abortReason);
    const spawn = row.aborted ? t.mock.method(cp, "spawn") : undefined;
    const watchdog = setTimeout(() => controller.abort(new Error("probe did not settle promptly")), 2000);
    t.after(() => clearTimeout(watchdog));
    const usages: AgyUsage[] = [];
    const probe = probeAgyAuthentication(executable, controller.signal, (usage) => {
      usages.push(usage);
      if (row.callbackError) throw row.callbackError;
    });

    const expectedError = row.aborted ? abortReason : row.error;
    if (expectedError instanceof Error) {
      await assert.rejects(probe, (error) => error === expectedError);
    } else if (expectedError) {
      await assert.rejects(probe, expectedError);
    } else {
      assert.equal(await probe, row.result);
    }

    if (spawn) assert.equal(spawn.mock.callCount(), 0);
    const expectsUsage = row.result === true || row.callbackError !== undefined;
    assert.equal(usages.length, expectsUsage ? 1 : 0);
    if (expectsUsage) {
      assert.deepEqual(usages[0]!.groups, groups);
      assert.ok(Number.isFinite(Date.parse(usages[0]!.updatedAt)));
    }
  });
}
