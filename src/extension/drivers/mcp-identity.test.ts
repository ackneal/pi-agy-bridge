import assert from "node:assert/strict";
import test from "node:test";
import { isRegisteredPiMcpTool } from "./mcp-identity.ts";

for (const row of [
  { name: "registered read", identity: { server: "pi-agy-bridge_pi", tool: "read" }, expected: true },
  { name: "registered bash", identity: { server: "pi-agy-bridge_pi", tool: "bash" }, expected: true },
  { name: "foreign server", identity: { server: "other", tool: "read" }, expected: false },
  { name: "unknown tool", identity: { server: "pi-agy-bridge_pi", tool: "write" }, expected: false },
  { name: "missing server", identity: { tool: "read" }, expected: false },
  { name: "missing tool", identity: { server: "pi-agy-bridge_pi" }, expected: false },
  { name: "non-string tool", identity: { server: "pi-agy-bridge_pi", tool: 42 }, expected: false },
  { name: "null", identity: null, expected: false },
  { name: "undefined", identity: undefined, expected: false },
  { name: "array", identity: [], expected: false },
  { name: "string", identity: "read", expected: false },
]) {
  test(`Pi MCP identity: ${row.name}`, () => {
    const allowed = new Set(["read", "bash"]);

    const registered = isRegisteredPiMcpTool(row.identity, allowed);

    assert.equal(registered, row.expected);
  });
}
