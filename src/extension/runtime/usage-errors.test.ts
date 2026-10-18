import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import test from "node:test";

test("fetchAgyUsage classifies subprocess failures and sanitizes diagnostics", async (t) => {
  let failure: Error;
  const replacement = Object.assign(() => {}, {
    [promisify.custom]: async (file: string, args: string[], options: { timeout: number; killSignal: string; encoding: string }) => {
      assert.equal(file, "/fake/agy");
      assert.deepEqual(args, ["--output-format", "json", "--print", "/usage"]);
      assert.equal(options.timeout, 30_000);
      assert.equal(options.killSignal, "SIGKILL");
      assert.equal(options.encoding, "utf-8");
      throw failure;
    },
  });
  const original = cp.execFile;
  cp.execFile = replacement as unknown as typeof cp.execFile;
  syncBuiltinESMExports();
  t.after(() => { cp.execFile = original; syncBuiltinESMExports(); });
  const { fetchAgyUsage } = await import("./usage.ts");

  for (const row of [
    { name: "failed authentication stderr", code: 1, stderr: "\u001b[31mAuthentication required\u001b[0m https://example.test/?token=secret-token authorization-code", stdout: "stdout-secret", reason: "process failed (exit 1)", diagnostic: "authentication required [redacted] [redacted]" },
    { name: "failed authentication stdout fallback", code: 2, stderr: "", stdout: "Please run login secret-token", reason: "process failed (exit 2)", diagnostic: "please run login [redacted]" },
    { name: "missing executable", code: "ENOENT", stderr: "", stdout: "", reason: "executable not found", diagnostic: "" },
    { name: "timeout", code: "ETIMEDOUT", killed: true, stderr: "", stdout: "", reason: "timed out after 30 seconds", diagnostic: "" },
  ]) {
    await t.test(row.name, async () => {
      failure = Object.assign(new Error("raw subprocess secret-token"), row);

      await assert.rejects(fetchAgyUsage("/fake/agy"), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, failure);
        assert.equal(error.message, `Antigravity CLI quota query ${row.reason}${row.diagnostic ? `: ${row.diagnostic}` : ""}. Check agy installation and run /login if authentication is required.`);
        assert.doesNotMatch(error.message, /secret-token|stdout-secret|authorization-code|https|\u001b/);
        return true;
      });
    });
  }
});
