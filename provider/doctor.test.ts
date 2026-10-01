import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("doctor reads isolated fixtures without installing or discovering", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agy-doctor-"));
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    // Import after HOME is set: the cache path is computed at module initialization.
    const { collectDoctorReport } = await import("./doctor.ts");
    const { MODEL_CACHE_PATH } = await import("../discovery/models.ts");
    assert.ok(MODEL_CACHE_PATH.startsWith(home + path.sep));
    const source = path.join(home, "source");
    const target = path.join(home, ".gemini/config/plugins/example");
    const executable = path.join(home, "agy");
    const calls = path.join(home, "calls");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "plugin.json"), JSON.stringify({ name: "example", version: "2.0.0" }));
    await fs.writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n[ "$*" = '--version' ] || exit 99\necho 'agy 1.2.0'\n`);
    await fs.chmod(executable, 0o755);
    const options = { agyPath: executable, pluginDir: source };
    for (const row of [
      { manifest: undefined, expected: /! Plugin not installed/, followup: /Will install automatically/ },
      { manifest: '{"name":"example","version":"2.0.0"}', expected: /✓ Plugin installed 2.0.0/, followup: /bundled 2.0.0/ },
      { manifest: '{"name":"example","version":"1.0.0"}', expected: /installed 1.0.0 -> bundled 2.0.0/, followup: /Will update automatically/ },
      { manifest: '{broken', expected: /✗ Plugin error/, followup: /Models: no cache/ },
      { manifest: '{}', expected: /✗ Plugin error/, followup: /Models: no cache/ },
    ]) {
      await fs.rm(target, { recursive: true, force: true });
      if (row.manifest !== undefined) {
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, "plugin.json"), row.manifest);
      }
      const report = await collectDoctorReport(options);
      assert.match(report, row.expected);
      assert.match(report, row.followup);
      assert.match(report, /✓ AGY 1.2.0 \(minimum 1.1.15\)/);
      assert.match(report, /MCP entrypoint exists/);
      if (row.manifest === undefined) await assert.rejects(fs.access(target));
      else assert.equal(await fs.readFile(path.join(target, "plugin.json"), "utf8"), row.manifest);
    }
    await fs.mkdir(path.dirname(MODEL_CACHE_PATH), { recursive: true });
    await fs.writeFile(MODEL_CACHE_PATH, '[{"id":"a","name":"A"}]');
    assert.match(await collectDoctorReport(options), /1 cached/);
    for (const value of ['{}', '[{}]', '{broken']) {
      await fs.writeFile(MODEL_CACHE_PATH, value);
      assert.match(await collectDoctorReport(options), /✗ Model cache error/);
      assert.match(await collectDoctorReport({ ...options, models: [] }), /0 configured/);
      assert.equal(await fs.readFile(MODEL_CACHE_PATH, "utf8"), value);
    }
    await fs.writeFile(path.join(source, "plugin.json"), '{}');
    const report = await collectDoctorReport({
      ...options, agyPath: path.join(home, "missing"), models: [1, 2],
      pluginError: { time: "2026-01-01T00:00:00Z", message: "install failed" },
      discoveryError: { time: "2026-01-02T00:00:00Z", message: "discovery failed" },
    });
    for (const pattern of [/✗ AGY error/, /Resolved AGY path:/, /✗ Plugin error/, /2 configured/, /Node version:/, /MCP entrypoint exists/, /Last plugin error at 2026-01-01T00:00:00Z: install failed/, /Last discovery error at 2026-01-02T00:00:00Z: discovery failed/, /Authentication, model execution, and Unix socket creation not tested\./]) assert.match(report, pattern);
    assert.ok((await fs.readFile(calls, "utf8")).trim().split("\n").every(call => call === "--version"));
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  }
});
