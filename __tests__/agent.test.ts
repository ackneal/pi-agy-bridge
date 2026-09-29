import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const pluginDir = fileURLToPath(new URL("../plugin/", import.meta.url));

describe("static AGY bridge plugin", () => {
  it("contains a static manifest and bridge agent", async () => {
    const manifest = JSON.parse(await readFile(`${pluginDir}/plugin.json`, "utf-8"));
    const markdown = await readFile(`${pluginDir}/agents/pi-bridge.md`, "utf-8");

    assert.equal(manifest.name, "pi-agy-bridge");
    assert.equal(manifest.version, "0.1.1");
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
    assert.match(markdown, /Do not claim that an external action succeeded unless the corresponding tool result confirms it/);
    assert.doesNotMatch(markdown, /session ID|conversation ID|PTY ID|socket|tool snapshot/i);
  });

  it("launches the packaged MCP executable through sh wrapper", async () => {
    const config = JSON.parse(await readFile(`${pluginDir}/mcp_config.json`, "utf-8"));
    const command = config.mcpServers["pi"];

    assert.equal(command.command, "sh");
    assert.deepEqual(command.args, ["-c", "exec $PI_AGY_BRIDGE_MCP_COMMAND"]);
  });
});
