import assert from "node:assert/strict";
import cp from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loginAgyAuthentication } from "./auth.ts";

test("cached login requests JSON usage once without input or PTY", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agy-auth-"));
  const executable = join(directory, "agy");
  const record = join(directory, "record.json");
  const spawn = cp.spawn;
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), input, noTTY: !process.stdin.isTTY && !process.stdout.isTTY && !process.stderr.isTTY }));
  process.stdout.write('Quota:\\nGemini Models  Weekly Limit Remaining 97%\\n');
}, 25);
`, { mode: 0o755 });
  const invocation = t.mock.method(cp, "spawn", (...args: Parameters<typeof cp.spawn>) => {
    assert.equal(args[0], executable, "cached login must not launch script");
    assert.deepEqual(args[1], ["--output-format", "json", "--print", "/usage"]);
    return spawn(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  await loginAgyAuthentication({
    signal: new AbortController().signal,
    notify() { assert.fail("cached login must not notify"); },
    prompt() { assert.fail("cached login must not prompt"); },
  }, executable);

  assert.equal(invocation.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(await readFile(record, "utf8")), {
    args: ["--output-format", "json", "--print", "/usage"],
    input: "",
    noTTY: true,
  });
});
