#!/usr/bin/env node
import path from "node:path";
import { decide as verifyArtifactPath } from "./restrict-read-file.js";

const malformed = { decision: "deny", reason: "Malformed Request: Invalid or missing arguments" };

export async function decide(input) {
  const toolCall = input?.toolCall;
  const name = toolCall?.name;
  if (typeof name !== "string" || !name) {
    return malformed;
  }

  if (name === "call_mcp_tool") {
    const serverName = toolCall?.args?.ServerName;
    if (serverName !== "pi-agy-bridge_pi") {
      return {
        decision: "deny",
        reason: `MCP server '${serverName ?? ""}' is unauthorized. Only 'pi-agy-bridge_pi' is allowed in Pi bridge mode.`,
      };
    }
    return { decision: "allow" };
  }

  if (name === "read_file") {
    return await verifyArtifactPath(input);
  }

  return {
    decision: "deny",
    reason: `Tool '${name}' is unauthorized. In Pi bridge mode, only 'call_mcp_tool' (for Pi tools) and 'read_file' (for step artifacts) are allowed.`,
  };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("Input too large");
    }
    console.log(JSON.stringify(await decide(JSON.parse(input))));
  } catch {
    console.log(JSON.stringify(malformed));
  }
}
