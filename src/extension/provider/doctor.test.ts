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
    const { collectDoctorReport } = await import("./doctor.ts");
    const source = path.join(home, "source");
    const target = path.join(home, ".gemini/config/plugins/example");
    const executable = path.join(home, "agy");
    const calls = path.join(home, "calls");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "plugin.json"), JSON.stringify({ name: "example", version: "2.0.0" }));
    await fs.writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n[ "$*" = '--version' ] || exit 99\necho 'agy 1.2.0'\n`);
    await fs.chmod(executable, 0o755);
    const options = { driver: "cli" as const, executable, pluginDir: source };
    for (const row of [
      { manifest: undefined, expected: /! Plugin example not installed/, followup: /Will install automatically on next Antigravity CLI use\./ },
      { manifest: '{"name":"example","version":"2.0.0"}', expected: /  ✓ Antigravity CLI 1.2.0 \(Plugin 2.0.0\)\n/, followup: /✓ Pi MCP bridge entrypoint found/ },
      { manifest: '{"name":"example","version":"1.0.0"}', expected: /Plugin example 1.0.0 -> bundled 2.0.0/, followup: /Will update automatically on next Antigravity CLI use\./ },
      { manifest: '{broken', expected: /✗ Plugin error/, followup: /Models: 0 cached/ },
      { manifest: '{}', expected: /✗ Plugin error/, followup: /Models: 0 cached/ },
    ]) {
      await fs.rm(target, { recursive: true, force: true });
      if (row.manifest !== undefined) {
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, "plugin.json"), row.manifest);
      }
      const report = await collectDoctorReport(options);
      assert.match(report, row.expected);
      assert.match(report, row.followup);
      assert.match(report, /^agy-bridge doctor\n/);
      assert.match(report, /  ✓ Antigravity CLI 1.2.0(?: \(Plugin 2.0.0\))?\n/);
      assert.doesNotMatch(report, /  ✓ Plugin /);
      assert.doesNotMatch(report, /\(minimum /);
      assert.match(report, /✓ Pi MCP bridge entrypoint/);
      if (row.manifest === undefined) await assert.rejects(fs.access(target));
      else assert.equal(await fs.readFile(path.join(target, "plugin.json"), "utf8"), row.manifest);
    }
    const { DEFAULT_AGY_PLUGIN_DIR } = await import("../discovery/plugin-install.ts");
    const bundled = JSON.parse(await fs.readFile(path.join(DEFAULT_AGY_PLUGIN_DIR, "plugin.json"), "utf8"));
    const defaultReport = await collectDoctorReport({ driver: "cli", executable });
    assert.ok(defaultReport.includes(`  ! Plugin ${bundled.name} not installed (bundled ${bundled.version})`));
    assert.match(defaultReport, /Will install automatically on next Antigravity CLI use\./);
    await assert.rejects(fs.access(path.join(home, ".gemini/config/plugins", bundled.name)));

    for (const row of [
      { catalogModels: undefined, models: undefined, expected: /! Models: 0 cached/ },
      { catalogModels: [], models: undefined, expected: /! Models: 0 cached/ },
      { catalogModels: [{ id: "a", name: "A" }], models: undefined, expected: /✓ Models: 1 cached/ },
      { catalogModels: [1], models: [], expected: /! Models: 0 configured/ },
      { catalogModels: [], models: [1, 2], expected: /✓ Models: 2 configured/ },
    ]) {
      const report = await collectDoctorReport({ ...options, catalogModels: row.catalogModels, models: row.models });
      assert.match(report, row.expected);
      if (row.models !== undefined) assert.doesNotMatch(report, /cached/);
    }
    for (const row of [
      {
        name: "unknown without local credential information remains unknown",
        authStatus: "unknown",
        expected: /x Auth: unknown/,
        authError: undefined,
        errors: false,
      },
      {
        name: "unknown with an auth error remains unknown",
        authStatus: "unknown",
        expected: /x Auth: unknown/,
        authError: { time: "2026-01-03T00:00:00Z", message: "login check failed" },
        errors: true,
      },
      { name: "authenticated", authStatus: "authenticated", expected: /✓ Auth: authenticated/, authError: undefined, errors: false },
      { name: "unauthenticated", authStatus: "unauthenticated", expected: /x Auth: unauthenticated/, authError: undefined, errors: false },
      { name: "saved credential is not backend verification", authStatus: "saved", expected: /x Auth: saved login \(backend unverified\)/, authError: undefined, errors: false },
    ] as const) {
      const report = await collectDoctorReport({ ...options, authStatus: row.authStatus, authError: row.authError });
      assert.match(report, row.expected, row.name);
      if (row.errors) {
        assert.match(report, /Errors\n  ! authentication \(2026-01-03T00:00:00Z\): login check failed/, row.name);
      } else {
        assert.doesNotMatch(report, /Errors/, row.name);
      }
    }
    await fs.writeFile(path.join(source, "plugin.json"), '{}');
    const report = await collectDoctorReport({
      ...options, executable: path.join(home, "missing"), models: [1, 2],
      pluginError: { time: "2026-01-01T00:00:00Z", message: "install failed" },
      discoveryError: { time: "2026-01-02T00:00:00Z", message: "discovery failed" },
      authStatus: "unauthenticated",
      authError: { time: "2026-01-03T00:00:00Z", message: "login failed" },
      usage: {
        updatedAt: "2026-10-17T04:19:59Z",
        groups: [{ name: "Gemini 4 Argon", buckets: [{ id: "argon", name: "Weekly", window: "weekly", remainingFraction: 0.4 }] }],
      },
      usageError: { time: "2026-01-04T00:00:00Z", message: "usage failed" },
    });
    for (const pattern of [
      /✗ Antigravity CLI error/,
      /✗ Plugin error/,
      /✓ Models: 2 configured/,
      /✓ Node /,
      /✓ Pi MCP bridge entrypoint/,
      /x Auth: unauthenticated/,
      /Quota remaining\n  Gemini 4 Argon  weekly 40%/,
      /Errors/,
      /! plugin \(2026-01-01T00:00:00Z\): install failed/,
      /! discovery \(2026-01-02T00:00:00Z\): discovery failed/,
      /! authentication \(2026-01-03T00:00:00Z\): login failed/,
      /! usage \(2026-01-04T00:00:00Z\): usage failed/,
    ]) assert.match(report, pattern);
    assert.ok((await fs.readFile(calls, "utf8")).trim().split("\n").every(call => call === "--version"));
    for (const row of [
      { name: "Build label", output: "Python 3.13.2\nBuild label: 1.4.1\n", runtime: "  ✓ Antigravity ACP 1.4.1" },
      { name: "missing version", output: "Python 3.13.2\n", runtime: "  ✓ Antigravity ACP" },
      { name: "empty version", output: "Build label:\n", runtime: "  ✓ Antigravity ACP" },
    ]) {
      const expectedArgs = process.platform === "linux" ? "--uid= --version" : "--version";
      await fs.writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n[ "$*" = '${expectedArgs}' ] || exit 99\nprintf '%s' '${row.output}'\n`);
      await fs.writeFile(calls, "");

      const acpReport = await collectDoctorReport({
        driver: "acp",
        executable,
        models: [1, 2],
        authStatus: "unauthenticated",
        discoveryError: { time: "2026-01-02T00:00:00Z", message: "discovery failed" },
        authError: { time: "2026-01-03T00:00:00Z", message: "login failed" },
        usage: {
          updatedAt: "2026-10-17T04:19:59Z",
          groups: [{ name: "Gemini 4 Argon", buckets: [{ id: "argon", name: "Weekly", window: "weekly", remainingFraction: 0.4 }] }],
        },
      });

      assert.match(acpReport, /^agy-bridge doctor\n\nRuntime\n/, row.name);
      assert.ok(acpReport.split("\n").includes(row.runtime), row.name);
      assert.match(acpReport, /  ✓ Node /, row.name);
      assert.match(acpReport, /  ✓ Pi MCP bridge entrypoint found\n/, row.name);
      assert.match(acpReport, /  ✓ Models: 2 configured\n  x Auth: unauthenticated/, row.name);
      assert.match(acpReport, /\n\nQuota remaining \(unavailable\)\n\nErrors\n  ! discovery \(2026-01-02T00:00:00Z\): discovery failed\n  ! authentication \(2026-01-03T00:00:00Z\): login failed$/, row.name);
      assert.doesNotMatch(acpReport, /Antigravity CLI|Plugin|Gemini 4 Argon|Python/, row.name);
      assert.equal(await fs.readFile(calls, "utf8"), `${expectedArgs}\n`, row.name);
      assert.equal(await fs.readFile(path.join(source, "plugin.json"), "utf8"), "{}");
      assert.equal(await fs.readFile(path.join(target, "plugin.json"), "utf8"), "{}");
    }

  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  }
});
