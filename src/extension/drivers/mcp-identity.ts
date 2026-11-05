export const PI_MCP_SERVER = "pi-agy-bridge_pi";

export function isRegisteredPiMcpTool(mcp: unknown, allowedToolNames: ReadonlySet<string>): mcp is { server: string; tool: string } {
  return mcp !== null && typeof mcp === "object" && !Array.isArray(mcp) &&
    "server" in mcp && mcp.server === PI_MCP_SERVER &&
    "tool" in mcp && typeof mcp.tool === "string" && allowedToolNames.has(mcp.tool);
}
