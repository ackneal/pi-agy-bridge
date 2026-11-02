import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Result } from "./report.ts";
import { scenarios } from "./scenarios.ts";

for (const row of [
  { name: "no opt-in", optIn: "", isolated: "", extended: "", selected: "", reason: /PI_AGY_LIVE=1/ },
  { name: "no isolation attestation", optIn: "1", isolated: "", extended: "", selected: "", reason: /disposable Linux container/ },
  { name: "no isolated workspace", optIn: "1", isolated: "1", extended: "", selected: "", reason: /PI_AGY_LIVE_WORKSPACE|disposable Linux container/ },
  { name: "extended no opt-in", optIn: "", isolated: "", extended: "1", selected: "", reason: /PI_AGY_LIVE=1/ },
  { name: "selected upgrade cases", optIn: "", isolated: "", extended: "", selected: "AUTH-probe,IMG-prompt-small,IMG-mcp-offload,OFFLOAD-text", reason: /PI_AGY_LIVE=1/ },
]) {
  test(`live entry stays offline: ${row.name}`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), "live-entry-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--test", "tests/live/acp.live.ts"], {
      env: { ...env, PI_AGY_LIVE: row.optIn, PI_AGY_LIVE_ISOLATED: row.isolated,
        PI_AGY_LIVE_WORKSPACE: "", PI_AGY_LIVE_SCENARIOS: row.selected, PI_AGY_LIVE_REPORT_DIR: directory,
        PI_AGY_LIVE_EXTENDED: row.extended, PI_AGY_LIVE_AUTH_STATE: "authenticated", PI_AGY_LIVE_LOGIN: "",
        PI_AGY_LIVE_INSTALL: "1", AGY_ACP_BIN: "/must-not-be-executed", PI_AGY_LIVE_TIMEOUT_MS: "1000" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(exit, 0, output);
    const results = JSON.parse(await readFile(path.join(directory, "results.json"), "utf8")) as Result[];
    const expected = row.selected ? row.selected.split(",") : scenarios.filter(([, , , tier]) => tier === "core" || row.extended === "1").map(([id]) => id);
    assert.deepEqual(results.map(result => result.id), expected);
    for (const result of results) {
      assert.equal(result.status, "SKIP");
      assert.match(result.reason, row.reason);
      assert.equal(result.environment.acp, "not resolved");
    }
  });
}
