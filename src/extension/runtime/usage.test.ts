import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AgyAuthenticationRequiredError, fetchAgyUsage, formatDoctorQuotaLines, parseAgyUsageOutput } from "./usage.ts";

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
    { name: "marker without percentage", input: "Quota\nLimit Remaining", expectedGroups: 0 },
    { name: "init is not quota", input: '{"event":"init"}', expectedGroups: 0 },
    { name: "invalid text percentage", input: "Pro  Five Hour  101%", expectedGroups: 0 },
    { name: "invalid JSON fraction", input: JSON.stringify({ command: { data: { groups: [{ name: "Pro", buckets: [{ remaining_fraction: 2 }] }] } } }), expectedGroups: 0 },
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
  for (const row of [
    { name: "failed authentication stderr", code: 1, stderr: "\u001b[31mAuthentication required\u001b[0m https://example.test/?token=secret-token authorization-code", stdout: "stdout-secret", reason: "process failed (exit 1)", diagnostic: "authentication required [redacted] [redacted]" },
    { name: "failed authentication stdout fallback", code: 2, stderr: "", stdout: "Please run login secret-token", reason: "process failed (exit 2)", diagnostic: "please run login [redacted]" },
    { name: "nonzero exit with valid quota", code: 7, stderr: "", stdout: sampleTextOutput, reason: "process failed (exit 7)", diagnostic: "" },
    ...(["stdout", "stderr"] as const).map((stream) => ({ name: `${stream} output bound`, code: 0, stderr: "", stdout: "", stream, reason: "process failed (exit ERR_CHILD_PROCESS_STDIO_MAXBUFFER)", diagnostic: "" })),
    { name: "missing executable", code: "ENOENT", stderr: "", stdout: "", reason: "executable not found", diagnostic: "" },
    { name: "timeout", code: "ETIMEDOUT", killed: true, stderr: "", stdout: "", reason: "timed out after 30 seconds", diagnostic: "" },
  ]) {
    await t.test(row.name, async (sub) => {
      const original = cp.spawn;
      sub.after(() => { cp.spawn = original; syncBuiltinESMExports(); });
      cp.spawn = ((file: string, args: string[]) => {
        assert.equal(file, "/fake/agy");
        assert.deepEqual(args, ["--output-format", "json", "--print", "/usage"]);
        const child = Object.assign(new EventEmitter(), {
          pid: 123456789,
          stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
          exitCode: null, signalCode: null,
          kill() { queueMicrotask(() => child.emit("close", null, "SIGKILL")); return true; },
        });
        sub.mock.method(process, "kill", () => {
          queueMicrotask(() => child.emit("close", null, "SIGKILL"));
          return true;
        });
        queueMicrotask(() => {
          if (row.code === "ENOENT") {
            child.emit("error", Object.assign(new Error("raw subprocess secret-token"), { code: row.code }));
            child.emit("close", -2, null);
          }
          else if (!("killed" in row)) {
            if ("stream" in row) {
              child[row.stream].write(Buffer.alloc(1024 * 1024 + 1, 120));
              return;
            }
            child.stdout.write(row.stdout);
            child.stderr.write(row.stderr);
            child.emit("close", row.code, null);
          }
        });
        return child;
      }) as unknown as typeof cp.spawn;
      syncBuiltinESMExports();
      if ("killed" in row) sub.mock.timers.enable({ apis: ["setTimeout"] });
      const query = fetchAgyUsage("/fake/agy");
      if ("killed" in row) sub.mock.timers.tick(30_000);
      await assert.rejects(query, (error: unknown) => {
        assert.ok(error instanceof Error);
        if (row.name === "failed authentication stderr") {
          assert.ok(error instanceof AgyAuthenticationRequiredError);
          return true;
        }
        assert.ok(!(error instanceof AgyAuthenticationRequiredError));
        if ("stream" in row) {
          const cause = error.cause as NodeJS.ErrnoException & { stdout: string; stderr: string };
          assert.equal(cause.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
          assert.ok(Buffer.byteLength(cause[row.stream]) <= 1024 * 1024);
          assert.doesNotMatch(error.message, /timed out/);
          return true;
        }
        if (row.name === "nonzero exit with valid quota") {
          assert.match(error.message, /process failed \(exit 7\)/);
          return true;
        }
        assert.equal(error.message, `Antigravity CLI quota query ${row.reason}${row.diagnostic ? `: ${row.diagnostic}` : ""}. Check agy installation and run /login if authentication is required.`);
        assert.doesNotMatch(error.message, /secret-token|stdout-secret|authorization-code|https|\u001b/);
        return true;
      });
    });
  }
});

for (const stream of ["stdout", "stderr"]) {
  test(`fetchAgyUsage stops a hanging split ${stream} authentication prompt`, async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agy-usage-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "agy");
    await writeFile(file, `#!${process.execPath}
process.${stream}.write("Authentication req");
setTimeout(() => process.${stream}.write("uired: login"), 50);
setInterval(() => {}, 1000);
`);
    await chmod(file, 0o755);
    const start = Date.now();
    await assert.rejects(fetchAgyUsage(file, AbortSignal.timeout(2500)), AgyAuthenticationRequiredError);
    assert.ok(Date.now() - start < 3000);
  });
}
