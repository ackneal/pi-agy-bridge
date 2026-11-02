import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { distributionName, resolveRelease } from "../src/extension/drivers/acp/release.ts";
import { installedAcp } from "./acp-installed.ts";

for (const row of [
  { name: "valid existing inventory", change: "none", code: undefined },
  { name: "missing cache", change: "missing", code: "ACP_INSTALL_REQUIRED" },
  { name: "different version", change: "version", code: "ACP_INSTALL_REQUIRED" },
  { name: "changed executable", change: "corrupt", code: "ACP_INSTALL_INVALID" },
  { name: "missing helper", change: "helper", code: "ACP_INSTALL_INVALID" },
]) {
  test(`existing ACP without download: ${row.name}`, async t => {
    const agent = await realpath(await mkdtemp(path.join(tmpdir(), "acp-existing-test-")));
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agent;
    t.after(async () => {
      if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
      await rm(agent, { recursive: true, force: true });
    });
    const release = resolveRelease();
    const root = path.join(agent, "pi-agy-bridge", "acp");
    const directory = path.join(root, distributionName(release));
    const files = [];
    if (row.change !== "missing") {
      await mkdir(directory, { recursive: true });
      for (const name of [release.executable, "localharness_external"]) {
        const content = `test-only inventory bytes for ${name}; never executed`;
        await writeFile(path.join(directory, name), content);
        await chmod(path.join(directory, name), 0o755);
        files.push({ path: name, type: "file", mode: 0o755, size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") });
      }
      await writeFile(path.join(directory, ".pi-agy-installation.json"), JSON.stringify({ schema: 1,
        version: row.change === "version" ? "0.0.0" : release.version, platform: release.platform, sha256: release.sha256, files }));
      if (row.change === "corrupt") await writeFile(path.join(directory, release.executable), "changed");
      if (row.change === "helper") await unlink(path.join(directory, "localharness_external"));
    }
    const before = row.change === "missing" ? undefined : await readFile(path.join(directory, release.executable), "utf8");
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("Resolver must not perform network I/O"));
    if (row.code) await assert.rejects(installedAcp(), error => (error as NodeJS.ErrnoException).code === row.code);
    else {
      const result = await installedAcp();
      assert.deepEqual(result.release, release);
      assert.equal(result.launch.executable, path.join(directory, release.executable));
      assert.deepEqual(result.launch.args, [...release.args]);
    }
    assert.equal(fetch.mock.callCount(), 0);
    if (before !== undefined) {
      assert.equal(await readFile(path.join(directory, release.executable), "utf8"), before, "Validation must not repair or replace existing bytes");
      assert.deepEqual(await readdir(root), [distributionName(release)], "Validator staging must settle before resolver returns");
    }
  });
}
