import { test, mock } from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeAgyAuthentication } from "./auth.ts";
import { summarizeAuthOutput } from "./auth-diagnostics.ts";

for (const output of ["Quota:", "usage", "usage-report", "model usage"]) {
  test(`authentication response hides internal wording: ${output}`, () => {
    assert.doesNotMatch(summarizeAuthOutput(output), /quota|usage|model/i);
  });
}

for (const enabled of [false, true]) {
  test(`headless probe debug ${enabled ? "on sanitizes artifact" : "off creates no artifact"}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "auth-diagnostics-"));
    const oldDebug = process.env.AGY_BRIDGE_DEBUG;
    const oldDirectory = process.env.AGY_BRIDGE_DEBUG_DIR;
    t.after(async () => {
      mock.restoreAll();
      syncBuiltinESMExports();
      if (oldDebug === undefined) delete process.env.AGY_BRIDGE_DEBUG;
      else process.env.AGY_BRIDGE_DEBUG = oldDebug;
      if (oldDirectory === undefined) delete process.env.AGY_BRIDGE_DEBUG_DIR;
      else process.env.AGY_BRIDGE_DEBUG_DIR = oldDirectory;
      await rm(directory, { recursive: true, force: true });
    });
    process.env.AGY_BRIDGE_DEBUG = enabled ? "1" : "0";
    process.env.AGY_BRIDGE_DEBUG_DIR = directory;
    const stdout = "Quota:\nLimit Remaining 97%\n";
    const stderr = "Error: unknown command --secret-option\nhttps://accounts.google.com/o/oauth2/auth?code=manual-code&token=secret-token&error=invalid\nmanual-code arbitrary-token SECRET_ENV_VALUE login=secret-token 4/authorization-code\nhttps://example.test/\n?token=hidden-value\n";
    mock.method(cp, "spawn", () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true,
      });
      queueMicrotask(() => {
        for (const chunk of stdout) child.stdout.write(chunk);
        for (const chunk of stderr) child.stderr.write(chunk);
        child.emit("close", 0, null);
      });
      return child;
    });
    syncBuiltinESMExports();

    assert.equal(await probeAgyAuthentication("/fake/agy"), true);
    const files = await readdir(directory);
    assert.equal(files.length, enabled ? 1 : 0);
    if (!enabled) return;

    const text = await readFile(join(directory, files[0]!), "utf8");
    const artifact = JSON.parse(text);
    assert.equal(artifact.source, new URL("./auth.ts", import.meta.url).href);
    assert.equal(artifact.executable, "/fake/agy");
    assert.deepEqual(artifact.args, ["--print", "/usage"]);
    assert.equal(artifact.exitCode, 0);
    assert.equal(artifact.exitSignal, null);
    assert.equal(artifact.stdoutBytes, Buffer.byteLength(stdout));
    assert.equal(artifact.stderrBytes, Buffer.byteLength(stderr));
    assert.equal(artifact.stdoutSummary, "[redacted]\nlimit remaining 97%\n");
    assert.match(artifact.stderrSummary, /^error unknown command \[redacted\]/);
    for (const secret of ["https", "accounts.google", "manual-code", "secret-token", "arbitrary-token", "SECRET_ENV_VALUE", "authorization-code", "hidden-value", "--secret-option"]) {
      assert.ok(!text.includes(secret), secret);
    }
  });
}
