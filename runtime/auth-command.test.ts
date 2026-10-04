import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loginAgyAuthentication, probeAgyAuthentication } from "./auth.ts";

for (const row of [
  { name: "successful built-in quota report", output: "Quota:\nGemini Models  Weekly Limit Remaining 97%\n", code: 0, success: true },
  { name: "indented quota report", output: "  Quota:  \r\nGemini Models  Weekly Limit Remaining 97%\r\n", code: 0, success: true },
  ...[
    ["unrecognized output", "report unavailable\n"],
    ["missing marker", "Remaining 100%\n"],
  ].map(([name, output]) => ({ name: `${name} rejects without retry`, output: output!, code: 0, success: false })),
  { name: "Quota alone", output: "Quota", code: 0, success: true },
  { name: "marker without percentage", output: "Limit Remaining\n", code: 0, success: true },
  { name: "quota data without heading", output: "Gemini Models Weekly Limit Remaining 97%\n", code: 0, success: true },
  { name: "zero exit without quota is unknown", output: "", code: 0, success: false },
  { name: "init alone does not prove authentication", output: '{"event":"init"}\n', code: 0, success: false },
  { name: "failed report is not authenticated", output: "Quota:\n", code: 3, success: false },
]) {
  test(`auth CLI command: ${row.name}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-auth-command-"));
    const executable = path.join(directory, "agy");
    t.after(() => rm(directory, { recursive: true, force: true }));
    const record = path.join(directory, "invocations");
    await writeFile(executable, `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(record)}, "call\\n");
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--print", "/usage"])) process.exit(9);
const report = () => process.stdout.write(${JSON.stringify(row.output)}, () => process.exit(${row.code}));
if (process.stdin.isTTY) report();
else {
  process.stdin.on("data", () => process.exit(8));
  process.stdin.on("end", report);
  process.stdin.resume();
}
`, { mode: 0o700 });

    const probe = probeAgyAuthentication(executable);
    if (row.success) {
      assert.equal(await probe, true);
      const prompts: unknown[] = [];
      await loginAgyAuthentication({
        signal: new AbortController().signal,
        notify: () => {},
        prompt: async (request) => { prompts.push(request); throw new Error("Cached login must not prompt"); },
      }, executable);
      assert.deepEqual(prompts, []);
    } else {
      await assert.rejects(probe, (error: Error) => {
        assert.ok(error.message.startsWith(`Could not determine Antigravity CLI authentication status (exitCode=${row.code}, signal=none, stdoutBytes=${Buffer.byteLength(row.output)}, stderrBytes=0)`));
        return true;
      });
      assert.equal(await readFile(record, "utf8"), "call\n", "invalid quota must not retry");
    }
  });
}
