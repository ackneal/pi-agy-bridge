import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { debugArtifact, setDebugOverride } from "./debug.ts";

test("diagnostic artifacts are debug-only and private", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-agy-debug-test-"));
  const previousDebug = process.env["AGY_BRIDGE_DEBUG"];
  const previousDirectory = process.env["AGY_BRIDGE_DEBUG_DIR"];
  process.env["AGY_BRIDGE_DEBUG_DIR"] = directory;
  setDebugOverride(false);

  try {
    for (const row of [
      { enabled: "0", label: "disabled", expectedCount: 0 },
      { enabled: "1", label: "enabled", expectedCount: 1 },
    ]) {
      process.env["AGY_BRIDGE_DEBUG"] = row.enabled;
      debugArtifact(row.label, { prompt: "test prompt" });
      const files = readdirSync(directory);
      assert.equal(files.length, row.expectedCount);
      if (row.expectedCount > 0) {
        const filename = path.join(directory, files[0]!);
        assert.deepEqual(JSON.parse(readFileSync(filename, "utf8")), { prompt: "test prompt" });
        assert.equal(statSync(filename).mode & 0o777, 0o600);
      }
    }
  } finally {
    if (previousDebug === undefined) delete process.env["AGY_BRIDGE_DEBUG"];
    else process.env["AGY_BRIDGE_DEBUG"] = previousDebug;
    if (previousDirectory === undefined) delete process.env["AGY_BRIDGE_DEBUG_DIR"];
    else process.env["AGY_BRIDGE_DEBUG_DIR"] = previousDirectory;
    rmSync(directory, { recursive: true, force: true });
  }
});
