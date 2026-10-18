import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { promisify } from "node:util";
import { formatDoctorQuotaLines, parseAgyUsageOutput } from "./usage.ts";

const sampleJsonOutput = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "Gemini Models\tWeekly Limit Remaining\t100%\t2026-10-24T04:19:59Z\n",
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          description: "Models within this group: Gemini Flash, Gemini Pro",
          buckets: [
            { id: "gemini-weekly", name: "WeeklyLimit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-10-24T04:19:59Z" },
            { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-10-17T09:19:59Z" },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            { id: "3p-weekly", name: "WeeklyLimit Remaining", window: "weekly", remaining_fraction: 0.833, reset_time: "2026-10-20T13:35:39Z" },
            { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-10-17T09:19:59Z" },
          ],
        },
        {
          name: "Gemini 4 Argon",
          buckets: [
            { id: "gemini-argon-wtu-weekly", name: "Gemini 4 Argon Weekly Limit", window: "weekly", remaining_fraction: 0.404, reset_time: "2026-10-24T00:18:14Z" },
          ],
        },
      ],
    },
  },
});

const sampleTextOutput = [
  "Quota:",
  "Gemini Models          Weekly Limit Remaining       100%  2026-10-24 12:19 CST",
  "Gemini Models          Five Hour Limit Remaining    100%  2026-10-17 17:19 CST",
  "Claude and GPT models  Weekly Limit Remaining       83%   2026-10-20 21:35 CST",
  "Claude and GPT models  Five Hour Limit Remaining    100%  2026-10-17 17:19 CST",
  "Gemini 4 Argon         Gemini 4 Argon Weekly Limit  42%   2026-10-24 08:18 CST",
].join("\n");

test("parseAgyUsageOutput parses JSON, text, and invalid inputs", () => {
  for (const row of [
    { name: "JSON command output", input: sampleJsonOutput, expectedGroups: 3, argonFraction: 0.404 },
    { name: "plain text quota output", input: sampleTextOutput, expectedGroups: 3, argonFraction: 0.42 },
    { name: "JSON response fallback", input: JSON.stringify({ response: sampleTextOutput }), expectedGroups: 3, argonFraction: 0.42 },
    { name: "empty output", input: "", expectedGroups: 0 },
    { name: "unrelated output", input: "Quota", expectedGroups: 0 },
  ]) {
    const usage = parseAgyUsageOutput(row.input, "2026-10-17T04:19:59Z");
    if (row.expectedGroups === 0) {
      assert.equal(usage, undefined, row.name);
      continue;
    }

    assert.ok(usage, row.name);
    assert.equal(usage.groups.length, row.expectedGroups, row.name);
    const argon = usage.groups.find((group) => group.name === "Gemini 4 Argon");
    assert.equal(argon?.buckets[0]?.remainingFraction, row.argonFraction, row.name);
  }
});

test("formatDoctorQuotaLines formats full report", () => {
  const nowMs = Date.parse("2026-10-17T04:19:59Z");
  const usage = parseAgyUsageOutput(sampleJsonOutput, "2026-10-17T04:19:59Z");

  assert.deepEqual(formatDoctorQuotaLines(usage, nowMs), [
    "",
    "Quota remaining",
    "  Gemini Models          5h 100% (5h) · weekly 100% (7d)",
    "  Claude and GPT models  5h 100% (5h) · weekly 83% (3d 9h)",
    "  Gemini 4 Argon         weekly 40% (6d 19h)",
  ]);
  assert.deepEqual(formatDoctorQuotaLines(undefined, nowMs), []);
});

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
