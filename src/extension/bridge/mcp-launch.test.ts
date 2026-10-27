import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMcpLaunchDescriptor, resolveMcpEntrypoint } from "./mcp-launch.ts";

test("shared MCP launch preserves executable and endpoint argv", () => {
  const entrypointPath = fileURLToPath(new URL("../../mcp/index.js", import.meta.url));
  assert.deepEqual(resolveMcpEntrypoint(), { nodePath: process.execPath, entrypointPath });

  for (const endpoint of ["unix:///tmp/bridge.sock?session=test", "unix:///tmp/space and 'quotes'.sock?session=a%20b"]) {
    assert.deepEqual(createMcpLaunchDescriptor(endpoint), {
      command: process.execPath,
      args: [entrypointPath, "--endpoint", endpoint],
    });
  }
});
