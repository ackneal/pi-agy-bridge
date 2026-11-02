import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(import.meta.dirname, "../..");

describe("Antigravity CLI MCP package", () => {
  it("resolves the documented package-root API to the shipped TypeScript entrypoint", async () => {
    assert.equal(import.meta.resolve("@ackneal/pi-agy-bridge"), new URL("../../src/extension/index.ts", import.meta.url).href);
    const api = await import("@ackneal/pi-agy-bridge");
    assert.equal(typeof api.setupAgyProvider, "function");
    assert.equal(typeof api.default, "function");
  });

  it("declares the SDK's zod peer as a production dependency with a resolvable v4 import", async () => {
    const manifest = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
    const sdkEntry = import.meta.resolve("@agentclientprotocol/sdk");
    const sdkManifest = JSON.parse(await readFile(new URL("../../../package.json", sdkEntry), "utf8"));
    const sdkRequire = createRequire(sdkEntry);
    const zodManifest = JSON.parse(await readFile(sdkRequire.resolve("zod/package.json"), "utf8"));

    // Pin the known-compatible version and peer contract rather than duplicating semver logic.
    assert.equal(sdkManifest.peerDependencies.zod, "^3.25.76 || ^4.0.0");
    assert.equal(manifest.dependencies.zod, "4.6.7", "published manifest must provide zod at runtime");
    assert.equal(zodManifest.version, manifest.dependencies.zod);

    const zod = await import(pathToFileURL(sdkRequire.resolve("zod/v4")).href);
    assert.equal(typeof zod.z.object, "function");
    await import(sdkEntry);
  });

  it("packs the plugin payload and executable JavaScript without local artifacts", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "pi-gear-npm-cache-"));
    try {
      const { stdout } = await execFileAsync(
        "npm",
        ["pack", "--dry-run", "--json", "--ignore-scripts"],
        { cwd: projectDir, env: { ...process.env, npm_config_cache: cache }, maxBuffer: 2_000_000 }
      );
      type PackEntry = { files: Array<{ path: string }> };
      const report = JSON.parse(stdout) as PackEntry[] | Record<string, PackEntry>;
      const packed = Array.isArray(report) ? report[0] : report["@ackneal/pi-agy-bridge"];
      assert.ok(packed, "npm pack must report the package payload");
      const files = packed.files.map((file) => file.path);

      for (const required of [
        "package.json",
        "src/extension/index.ts",
        "src/extension/discovery/model.json",
        "src/extension/drivers/acp/registry.json",
        "src/extension/drivers/acp/noninteractive-browser.js",
        "src/mcp/index.js",
        "src/mcp/socket.js",
        "src/mcp/socket.d.ts",
        "README.md",
        "LICENSE",
        "plugin/plugin.json",
        "plugin/mcp_config.json",
        "plugin/agents/pi-bridge.md",
        "plugin/agents/pi-standalone.md",
      ]) {
        assert.ok(files.includes(required), `missing packed file: ${required}`);
      }

      const moduleDirs = ["shared", "runtime", "bridge", "session", "discovery", "provider", "drivers"];
      for (const dir of moduleDirs) {
        const entries = await readdir(path.join(projectDir, "src/extension", dir), { recursive: true });
        const modules = entries
          .map(String)
          .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith("-fixture.ts"));
        for (const module of modules) {
          const packedPath = path.posix.join("src/extension", dir, ...module.split(path.sep));
          assert.ok(files.includes(packedPath), `missing packed module: ${packedPath}`);
        }
      }
      assert.ok(!files.some((file) => file.includes("/.gemini/") || file.includes("/__tests__/") || file.endsWith(".test.ts") || file.endsWith("-fixture.ts")));
      for (const developmentPath of [".github/", "scripts/", "docs/", "experiments/", "tests/", "bun.lock", "tsconfig.json"]) {
        assert.ok(!files.some((file) => file.startsWith(developmentPath)), `packed development artifact: ${developmentPath}`);
      }

      const binPath = path.join(projectDir, "src/mcp/index.js");
      await access(binPath);
      assert.notEqual((await stat(binPath)).mode & 0o111, 0, "packaged MCP bin must be executable");
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });
});
