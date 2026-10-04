import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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

  it("packs the plugin payload and executable JavaScript without local artifacts", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "pi-gear-npm-cache-"));
    try {
      const { stdout } = await execFileAsync(
        "npm",
        ["pack", "--dry-run", "--json", "--ignore-scripts"],
        { cwd: projectDir, env: { ...process.env, npm_config_cache: cache }, maxBuffer: 2_000_000 }
      );
      const report = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
      const files = report[0]?.files.map((file) => file.path) ?? [];

      for (const required of [
        "src/extension/index.ts",
        "src/extension/discovery/model.json",
        "src/mcp/index.js",
        "src/mcp/socket.js",
        "src/mcp/socket.d.ts",
        "README.md",
        "LICENSE",
        "plugin/plugin.json",
        "plugin/mcp_config.json",
        "plugin/agents/pi-bridge.md",
      ]) {
        assert.ok(files.includes(required), `missing packed file: ${required}`);
      }

      const moduleDirs = ["shared", "runtime", "bridge", "session", "discovery", "provider"];
      for (const dir of moduleDirs) {
        const entries = await readdir(path.join(projectDir, "src/extension", dir), { recursive: true });
        const modules = entries
          .map(String)
          .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
        for (const module of modules) {
          const packedPath = path.posix.join("src/extension", dir, ...module.split(path.sep));
          assert.ok(files.includes(packedPath), `missing packed module: ${packedPath}`);
        }
      }
      assert.ok(!files.some((file) => file.includes("/.gemini/") || file.includes("/__tests__/") || file.endsWith(".test.ts")));
      for (const developmentPath of [".github/", "scripts/", "docs/", "tests/", "bun.lock", "tsconfig.json"]) {
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
