import { fileURLToPath } from "node:url";

export interface McpLaunchDescriptor {
  command: string;
  args: [entrypoint: string, endpointFlag: "--endpoint", endpoint: string];
}

export function resolveMcpEntrypoint(): { nodePath: string; entrypointPath: string } {
  return {
    nodePath: process.execPath,
    entrypointPath: fileURLToPath(new URL("../../mcp/index.js", import.meta.url)),
  };
}

export function createMcpLaunchDescriptor(endpoint: string): McpLaunchDescriptor {
  const { nodePath, entrypointPath } = resolveMcpEntrypoint();
  return { command: nodePath, args: [entrypointPath, "--endpoint", endpoint] };
}
