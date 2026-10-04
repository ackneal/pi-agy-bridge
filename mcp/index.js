#!/usr/bin/env node

import readline from "node:readline";
import { connectBridge, parseBridgeUri } from "./socket.js";

const JSON_RPC_VERSION = "2.0";
const SERVER_INFO = { name: "pi-agy-bridge", version: "0.1.2" };

async function main() {
  const bridgeUri = getBridgeEndpoint();
  const socket = await connectBridge(parseBridgeUri(bridgeUri));
  const input = readline.createInterface({ input: process.stdin, terminal: false });
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    input.close();
    socket.close();
  };

  socket.onDisconnect((error) => {
    process.stderr.write(`pi-agy-bridge-mcp transport failed: ${error.message}\n`);
    process.exitCode = 1;
    close();
  });

  input.on("line", (line) => {
    if (line.trim() === "") return;
    void handleLine(line, socket).catch((error) => {
      debugLog("Request handling failed:", error);
    });
  });
  input.once("close", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

async function handleLine(line, socket) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    writeError(null, -32700, "Parse error");
    return;
  }

  if (!isRecord(request) || request.jsonrpc !== JSON_RPC_VERSION || typeof request.method !== "string") {
    writeError(requestId(request), -32600, "Invalid Request");
    return;
  }

  const id = requestId(request);
  if (id === undefined) return;

  try {
    switch (request.method) {
      case "initialize":
        writeResult(id, {
          protocolVersion: protocolVersion(request.params),
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
        return;
      case "ping":
        writeResult(id, {});
        return;
      case "tools/list": {
        const tools = [...socket.listTools()];
        debugLog("MCP tools/list:", tools.map((tool) => tool.name));
        writeResult(id, { tools });
        return;
      }
      case "tools/call": {
        const params = request.params;
        if (!isRecord(params) || typeof params.name !== "string") {
          writeError(id, -32602, "Invalid tools/call parameters");
          return;
        }
        const args = params.arguments === undefined ? {} : params.arguments;
        if (!isRecord(args)) {
          writeError(id, -32602, "Tool arguments must be an object");
          return;
        }
        writeResult(id, await socket.callTool(params.name, args));
        return;
      }
      default:
        writeError(id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    writeError(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

function writeResult(id, result) {
  writeMessage({ jsonrpc: JSON_RPC_VERSION, id, result });
}

function writeError(id, code, message) {
  writeMessage({ jsonrpc: JSON_RPC_VERSION, id, error: { code, message } });
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function requestId(value) {
  if (!isRecord(value) || !("id" in value)) return undefined;
  return typeof value.id === "string" || typeof value.id === "number" || value.id === null
    ? value.id
    : undefined;
}

function protocolVersion(params) {
  return isRecord(params) && typeof params.protocolVersion === "string"
    ? params.protocolVersion
    : "2025-06-18";
}

function debugLog(...args) {
  if (process.env.AGY_BRIDGE_DEBUG !== "1" && process.env.AGY_BRIDGE_DEBUG?.toLowerCase() !== "true") return;
  process.stderr.write(`[pi-agy-bridge-mcp] ${args.map(String).join(" ")}\n`);
}

function getBridgeEndpoint() {
  const args = process.argv.slice(2);
  const endpointIndex = args.indexOf("--endpoint");
  const value = endpointIndex === -1 ? undefined : args[endpointIndex + 1];
  if (value?.trim()) return value.trim();
  throw new Error("Missing required --endpoint argument");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`pi-agy-bridge-mcp startup failed: ${message}\n`);
  process.exitCode = 1;
});
