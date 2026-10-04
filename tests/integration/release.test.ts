import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "node:test";

const execFileAsync = promisify(execFile);
const root = new URL("../../", import.meta.url);
const { version } = JSON.parse(await readFile(new URL("package.json", root), "utf8")) as { version: string };
const script = fileURLToPath(new URL("scripts/check-version.js", root));

for (const { name, args, valid } of [
  { name: "accepts aligned package versions without a tag", args: [], valid: true },
  { name: "accepts the matching release tag", args: [`v${version}`], valid: true },
  { name: "rejects a mismatched release tag", args: ["v999.999.999"], valid: false },
  { name: "rejects a version without the tag prefix", args: [version], valid: false },
]) {
  it(name, async () => {
    const execution = execFileAsync(process.execPath, [script, ...args], { cwd: "/tmp" });
    if (valid) {
      const { stdout } = await execution;
      assert.match(stdout, /Release version verified:/);
    } else {
      await assert.rejects(execution, /release tag must match package version/);
    }
  });
}
