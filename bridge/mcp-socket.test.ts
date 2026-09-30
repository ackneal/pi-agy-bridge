import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  connectBridge,
  formatBridgeUri,
  parseBridgeUri,
  type BridgeSocketClient,
} from "../mcp/socket.js";

type Message = Record<string, unknown>;
type Fixture = {
  client: BridgeSocketClient;
  server: Server;
  socket: Socket;
  endpoint: string;
  close: () => Promise<void>;
};

async function startFixture(t: { skip: (reason?: string) => void }, onMessage?: (message: Message, socket: Socket) => void): Promise<Fixture | null> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-socket-test-"));
  const endpoint = path.join(directory, "bridge.sock");
  const server = net.createServer();
  let socket: Socket | undefined;
  let buffer = "";
  server.on("connection", (connection) => {
    socket = connection;
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          const message = JSON.parse(line) as Message;
          if (message.type === "hello") {
            send(connection, { type: "tools", tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] });
          }
          onMessage?.(message, connection);
        }
        newline = buffer.indexOf("\n");
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Unix domain sockets are unavailable in this sandbox");
      return null;
    }
    throw error;
  }

  const close = async () => {
    socket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const client = await connectBridge({ endpoint, sessionId: "transport-session" });
    return { client, server, socket: socket!, endpoint, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function send(socket: Socket, message: Message): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

async function withFixture(
  t: { skip: (reason?: string) => void },
  onMessage?: (message: Message, socket: Socket) => void,
  run?: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const fixture = await startFixture(t, onMessage);
  if (!fixture) return;
  try {
    await run?.(fixture);
  } finally {
    fixture.client.close();
    await fixture.close();
  }
}

describe("BridgeSocketClient", () => {
  it("round-trips the bridge URI contract", () => {
    const value = formatBridgeUri({
      endpoint: "/tmp/pi gear/bridge.sock",
      sessionId: "session/value",
    });

    assert.equal(value, "unix:///tmp/pi%20gear/bridge.sock?session=session%2Fvalue");
    assert.deepEqual(parseBridgeUri(value), {
      endpoint: "/tmp/pi gear/bridge.sock",
      sessionId: "session/value",
    });
  });

  it("sends the transport-owned sessionId and lists server tools", async (t) => {
    let hello: Message | undefined;
    await withFixture(t, (message) => {
      if (message.type === "hello") hello = message;
    }, async ({ client }) => {
      assert.deepEqual(hello, { type: "hello", sessionId: "transport-session" });
      assert.deepEqual(client.listTools().map((tool) => tool.name), ["echo"]);
    });
  });

  it("correlates concurrent calls out of order without injecting sessionId into arguments", async (t) => {
    const calls: Message[] = [];
    await withFixture(t, (message, socket) => {
      if (message.type !== "call") return;
      calls.push(message);
      if (calls.length === 2) {
        send(socket, { type: "result", id: calls[1]!.id, result: { value: "second" } });
        send(socket, { type: "result", id: calls[0]!.id, result: { value: "first" } });
      }
    }, async ({ client }) => {
      const first = client.callTool("echo", { value: 1 });
      const second = client.callTool("echo", { value: 2 });
      assert.deepEqual(await second, { value: "second" });
      assert.deepEqual(await first, { value: "first" });
      assert.deepEqual(calls.map((call) => call.arguments), [{ value: 1 }, { value: 2 }]);
      assert.ok(calls.every((call) => !("sessionId" in (call.arguments as object))));
    });
  });

  it("returns tool error results normally", async (t) => {
    await withFixture(t, (message, socket) => {
      if (message.type === "call") send(socket, { type: "result", id: message.id, result: { isError: true, content: [{ type: "text", text: "failed" }] } });
    }, async ({ client }) => {
      assert.deepEqual(await client.callTool("echo", {}), { isError: true, content: [{ type: "text", text: "failed" }] });
    });
  });

  for (const [label, response, expected] of [
    ["malformed result", { type: "result", id: "not-a-call" }, /invalid protocol message/],
    ["unknown result", { type: "result", id: "unknown", result: true }, /unknown result ID: unknown/],
  ] as const) {
    it(`rejects pending calls on ${label}`, async (t) => {
      await withFixture(t, (message, socket) => {
        if (message.type === "call") send(socket, response);
      }, async ({ client }) => {
        await assert.rejects(client.callTool("echo", {}), expected);
      });
    });
  }

  it("rejects pending calls when the bridge disconnects", async (t) => {
    await withFixture(t, (message, socket) => {
      if (message.type === "call") socket.destroy();
    }, async ({ client }) => {
      await assert.rejects(client.callTool("echo", {}), /Bridge socket disconnected/);
    });
  });

  it("reports an unknown-session error clearly", async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-session-test-"));
    const endpoint = path.join(directory, "bridge.sock");
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", () => send(socket, { type: "error", message: "Unknown session: transport-session" }));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, resolve);
      });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Unix domain sockets are unavailable in this sandbox");
        return;
      }
      throw error;
    }
    try {
      await assert.rejects(connectBridge({ endpoint, sessionId: "transport-session" }), /Unknown session: transport-session/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("close is idempotent and cleans up pending calls", async (t) => {
    await withFixture(t, undefined, async ({ client, socket }) => {
      const pending = client.callTool("echo", {});
      client.close();
      client.close();
      await assert.rejects(pending, /Bridge socket client closed/);
      socket.destroy();
      assert.throws(() => client.listTools(), /disconnected or closed/);
    });
  });
});
