import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { it } from "node:test";
import { formatBridgeUri } from "./socket.js";

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
