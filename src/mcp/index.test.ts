import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { it } from "node:test";
import { formatBridgeUri } from "./socket.js";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

// Replace only the OS transport; the child runs the real MCP and socket modules.
const transport = `
import net from "node:net";
import { Duplex } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
net.createConnection = () => {
  let waiting;
  const socket = new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      const message = JSON.parse(chunk.toString());
      const send = (value) => this.push(JSON.stringify(value) + "\\n");
      if (message.type === "hello") send({ type: "tools", tools: [] });
      if (message.type === "call") {
        if (message.name === "wait") waiting = message.id;
        else {
          if (message.name === "release") send({ type: "result", id: waiting, result: "late" });
          send({ type: "result", id: message.id, result: "ok" });
        }
      }
      callback();
    }
  });
  process.nextTick(() => socket.emit("connect"));
  return socket;
};
syncBuiltinESMExports();
`;

for (const [method, key] of [["notifications/cancelled", "requestId"], ["$/cancelRequest", "id"]] as const) {
  it(`${method} suppresses only the canceled proxy response`, async (t) => {
    const child = spawn(process.execPath, [
      "--import", `data:text/javascript,${encodeURIComponent(transport)}`,
      fileURLToPath(new URL("./index.js", import.meta.url)),
      "--endpoint", formatBridgeUri({ endpoint: "/mock/bridge.sock", sessionId: "test" }),
    ], { stdio: "pipe" });
    const exited = once(child, "exit");
    const lines = readline.createInterface({ input: child.stdout });
    const responses: Record<string, unknown>[] = [];
    const waiters = new Map<string | number, () => void>();
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    lines.on("line", (line) => {
      const response = JSON.parse(line);
      responses.push(response);
      waiters.get(response.id)?.();
      waiters.delete(response.id);
    });
    t.after(async () => {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    });

    const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const responseFor = (id: string | number) => new Promise<void>((resolve) => { waiters.set(id, resolve); });
    const other = responseFor(2);
    send({ method: "notifications/initialized" });
    send({ id: 1, method: "tools/call", params: { name: "wait" } });
    send({ method, params: { [key]: 1 } });
    send({ method, params: { [key]: "unknown" } });
    send({ id: 2, method: "tools/call", params: { name: "other" } });
    await other;

    // Its response proves cancellation was processed before releasing the late result.
    const released = responseFor(3);
    send({ id: 3, method: "tools/call", params: { name: "release" } });
    await released;

    const barrier = responseFor("barrier");
    send({ method, params: { [key]: 2 } });
    send({ id: "barrier", method: "ping" });
    await barrier;
    assert.deepEqual(responses, [
      { jsonrpc: "2.0", id: 2, result: "ok" },
      { jsonrpc: "2.0", id: 3, result: "ok" },
      { jsonrpc: "2.0", id: "barrier", result: {} },
    ]);
    assert.equal(stderr, "");
  });
}

for (const row of [
  { name: "CLI discovery metadata", method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } }, version: "2026-07-28" },
  { name: "explicit version takes precedence", method: "server/discover", params: { protocolVersion: "2025-06-18", _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } }, version: "2025-06-18" },
  { name: "missing params", method: "server/discover", params: undefined, version: "2025-06-18" },
  { name: "invalid metadata", method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": 42 } }, version: "2025-06-18" },
  { name: "initialize retains explicit version", method: "initialize", params: { protocolVersion: "2024-11-05" }, version: "2024-11-05" },
]) {
  it(`negotiates MCP version: ${row.name}`, async (t) => {
    const child = spawn(process.execPath, [
      "--import", `data:text/javascript,${encodeURIComponent(transport)}`,
      fileURLToPath(new URL("./index.js", import.meta.url)),
      "--endpoint", formatBridgeUri({ endpoint: "/mock/bridge.sock", sessionId: "test" }),
    ], { stdio: "pipe" });
    const exited = once(child, "exit");
    const lines = readline.createInterface({ input: child.stdout });
    let response: Record<string, unknown> | undefined;
    const waited = new Promise<void>((resolve) => {
      lines.on("line", (line) => {
        response = JSON.parse(line);
        resolve();
      });
    });
    t.after(async () => {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: row.method,
      params: row.params,
    }) + "\n");
    await waited;

    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: row.version,
        capabilities: { tools: {} },
        serverInfo: { name: "pi-agy-bridge", version },
      },
    });
  });
}

