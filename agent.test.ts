import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { BridgeIPC } from "./bridge/bridge-ipc.ts";
import { mkdtemp, symlink, writeFile, rm, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const projectDir = fileURLToPath(new URL("./", import.meta.url));
const pluginDir = fileURLToPath(new URL("./plugin/", import.meta.url));

describe("static AGY bridge plugin", () => {
  it("keeps package, plugin, and MCP versions aligned", async () => {
    const packageManifest = JSON.parse(await readFile(`${projectDir}/package.json`, "utf-8"));
    const pluginManifest = JSON.parse(await readFile(`${pluginDir}/plugin.json`, "utf-8"));
    const mcpEntrypoint = await readFile(`${projectDir}/mcp/index.js`, "utf-8");

    assert.equal(packageManifest.version, "0.1.2");
    assert.equal(pluginManifest.version, packageManifest.version);
    assert.match(mcpEntrypoint, new RegExp(`SERVER_INFO = \\{ name: "pi-agy-bridge", version: "${packageManifest.version}" \\}`));
  });

  it("contains a static manifest and bridge agent", async () => {
    const manifest = JSON.parse(await readFile(`${pluginDir}/plugin.json`, "utf-8"));
    const markdown = await readFile(`${pluginDir}/agents/pi-bridge.md`, "utf-8");

    assert.equal(manifest.name, "pi-agy-bridge");
    assert.equal(manifest.version, "0.1.2");
    assert.match(markdown, /^---\nname: pi-bridge\n/);
    assert.match(markdown, /\nmainAgent: true\n/);
    assert.match(markdown, /\nsubagent: false\n/);
    assert.match(markdown, /\ncommandExecutionPolicy: sandbox\n/);
    assert.match(markdown, /\nexcludeDefaultComponents: true\n/);
    assert.match(markdown, /\ninheritMcp: true\n/);
    assert.doesNotMatch(markdown, /\ntools:\n/);
    assert.match(markdown, /model runtime delegated by Pi/);
    assert.match(markdown, /<pi_context purpose="reconstructed_conversation">/);
    assert.match(markdown, /<system_instructions>/);
    assert.match(markdown, /<history>/);
    assert.match(markdown, /<current_message>/);
    assert.match(markdown, /dynamically supplied by the MCP server `pi-agy-bridge_pi`/);
    assert.match(markdown, /Use only the tools advertised by that MCP server/);
    assert.match(markdown, /Follow each advertised tool input schema exactly/);
    assert.match(markdown, /If a call fails schema validation, correct the arguments/);
    assert.match(markdown, /Do not claim that an external action succeeded unless the corresponding tool result confirms it/);
    assert.doesNotMatch(markdown, /session ID|conversation ID|PTY ID|socket|tool snapshot/i);
  });

  it("launches the packaged MCP executable through sh wrapper", async () => {
    const config = JSON.parse(await readFile(`${pluginDir}/mcp_config.json`, "utf-8"));
    const command = config.mcpServers["pi"];

    assert.equal(command.command, "sh");
    assert.deepEqual(command.args, ["-c", 'exec "$PI_AGY_BRIDGE_MCP_NODE" "$PI_AGY_BRIDGE_MCP_ENTRYPOINT" --endpoint "$PI_AGY_BRIDGE_MCP_ENDPOINT"']);
  });

  it("preserves spaced paths and literal shell characters as real shell argv", async (t) => {
    const config = JSON.parse(await readFile(`${pluginDir}/mcp_config.json`, "utf-8"));
    const command = config.mcpServers.pi;
    const directory = await mkdtemp(path.join(os.tmpdir(), "pab shell "));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const entrypoint = path.join(directory, "entry ' $; 中文.js");
    await writeFile(entrypoint, "console.log(JSON.stringify(process.argv.slice(1)))");

    for (const name of ["node with spaces", "node ' $; 中文"]) {
      const nodePath = path.join(directory, name);
      await symlink(process.execPath, nodePath);
      const bridge = new BridgeIPC([], "session ' $; 中文");
      (bridge as unknown as { socketPath: string }).socketPath = path.join(directory, "socket with spaces.sock");
      const originalNodePath = process.execPath;
      let environment: NodeJS.ProcessEnv;
      try {
        process.execPath = nodePath;
        environment = bridge.processEnvironment;
      } finally {
        process.execPath = originalNodePath;
      }
      assert.equal(environment.PI_AGY_BRIDGE_MCP_NODE, nodePath);
      assert.equal(environment.PI_AGY_BRIDGE_MCP_ENTRYPOINT, fileURLToPath(new URL("./mcp/index.js", import.meta.url)));
      assert.equal(environment.PI_AGY_BRIDGE_MCP_ENDPOINT, bridge.bridgeUri);

      const result = spawnSync(command.command, command.args, {
        encoding: "utf8",
        env: { ...process.env, ...environment, PI_AGY_BRIDGE_MCP_ENTRYPOINT: entrypoint },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [entrypoint, "--endpoint", bridge.bridgeUri]);
    }
  });
});
