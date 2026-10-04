import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import net, { type Socket } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import { AgyMcpServer, cleanOrphanSockets } from "./bridge-ipc.ts";
import { connectBridge, parseBridgeUri } from "../../mcp/socket.js";

describe("AgyMcpServer", () => {
  for (const phase of ["mkdir", "listen", "chmod", "failure"] as const) {
    it(`serializes concurrent starts and close during ${phase}`, async (t) => {
      const bridge = new AgyMcpServer([]);
      const exitListeners = process.listeners("exit");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let reached!: () => void;
      const entered = new Promise<void>((resolve) => { reached = resolve; });
      let created = 0;
      let closed = 0;
      const unlinked: string[] = [];
      let endpoint = "";
      const server = Object.assign(new EventEmitter(), {
        listening: false,
        listen(socketPath: string, callback: () => void) {
          endpoint = socketPath;
          void (async () => {
            if (phase === "listen") {
              reached();
              await gate;
            }
            server.listening = true;
            callback();
          })();
        },
        close(callback: () => void) {
          closed++;
          server.listening = false;
          callback();
        },
      });

      t.after(async () => {
        release();
        await bridge.close();
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
      t.mock.method(net, "createServer", () => { created++; return server; });
      syncBuiltinESMExports();
      t.mock.method(fs, "mkdir", async () => {
        if (phase === "mkdir") {
          reached();
          await gate;
        }
      });
      t.mock.method(fs, "readdir", async () => []);
      t.mock.method(fs, "chmod", async () => {
        if (phase === "chmod" || phase === "failure") {
          reached();
          await gate;
        }
        if (phase === "failure") throw new Error("chmod failed");
      });
      t.mock.method(fs, "unlink", async (socketPath: string) => { unlinked.push(socketPath); });

      const starting = bridge.start();
      const startOutcome = phase === "failure"
        ? assert.rejects(starting, /chmod failed/)
        : assert.doesNotReject(starting);
      await entered;
      await assert.rejects(bridge.start(), /already running/);
      const closing = bridge.close();
      const secondClose = bridge.close();
      await assert.rejects(bridge.start(), /already running/);
      release();
      await Promise.all([startOutcome, closing, secondClose]);

      assert.equal(created, 1);
      assert.equal(closed, 1);
      assert.equal(server.listening, false);
      assert.deepEqual(unlinked, [endpoint]);
      assert.deepEqual(process.listeners("exit"), exitListeners);
      assert.throws(() => bridge.bridgeUri, /not been started/);
    });
  }

  for (const event of ["error", "close"] as const) {
    it(`cancels a pending call on socket ${event}`, async (t) => {
      const bridge = new AgyMcpServer([{
        name: "read", description: "Read", parameters: Type.Object({}),
      }]);
      const socket = Object.assign(new EventEmitter(), {
        destroyed: false,
        write: () => true,
        end: () => assert.fail("Rejected message"),
        destroy() {
          socket.destroyed = true;
          socket.emit("close");
        },
      });
      t.after(() => bridge.close());
      bridge.setToolCallHandler(() => {});
      (bridge as unknown as { handleConnection(socket: Socket): void }).handleConnection(socket as unknown as Socket);
      socket.emit("data", Buffer.from(
        `${JSON.stringify({ type: "hello", sessionId: bridge.sessionId })}\n` +
        `${JSON.stringify({ type: "call", id: "1", name: "read", arguments: {} })}\n`
      ));
      assert.equal(bridge.hasPendingCalls, true);

      if (event === "error") {
        assert.doesNotThrow(() => socket.emit("error", new Error("connection reset")));
        assert.equal(socket.destroyed, true);
      } else {
        socket.destroy();
      }
      assert.equal(bridge.hasPendingCalls, false);
      await Promise.resolve();
    });
  }

  it("decodes Chinese broker messages across Buffer boundaries without a socket", async () => {
    const text = "中文路徑";
    const hello = Buffer.from(`${JSON.stringify({ type: "hello", sessionId: text })}\n`);
    const call = Buffer.from(`${JSON.stringify({ type: "call", id: "1", name: "read", arguments: { path: text } })}\n`);
    const wire = Buffer.concat([hello, call]);
    const firstChineseByte = wire.indexOf(Buffer.from("中"));
    const cases = [
      [wire],
      [wire.subarray(0, firstChineseByte + 1), wire.subarray(firstChineseByte + 1)],
      [wire.subarray(0, firstChineseByte + 2), wire.subarray(firstChineseByte + 2)],
      Array.from(wire, (byte) => Buffer.from([byte])),
    ];

    for (const chunks of cases) {
      const bridge = new AgyMcpServer([{ name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) }], text);
      const socket = Object.assign(new EventEmitter(), { write: () => true, end: () => assert.fail("Rejected message"), destroy: () => { socket.emit("close"); } });
      let relayed: unknown;
      bridge.setToolCallHandler((batch) => { relayed = batch.calls[0]?.arguments; });

      try {
        (bridge as unknown as { handleConnection(socket: Socket): void }).handleConnection(socket as unknown as Socket);
        for (const chunk of chunks) socket.emit("data", chunk);
        await waitFor(() => relayed !== undefined);
        assert.deepEqual(relayed, { path: text });
      } finally {
        await bridge.close();
      }
    }
  });

  it("exposes only its Pi context tools over stdio and relays results", async (t) => {
    const bridge = new AgyMcpServer([{
      name: "read",
      description: "Read a file",
      parameters: Type.Object({ path: Type.String() }),
    }]);
    let child: ChildProcessWithoutNullStreams | null = null;

    try {
      try {
        await bridge.start();
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM") {
          t.skip("Unix domain sockets are unavailable in this sandbox");
          return;
        }
        throw error;
      }
      const environment = bridge.processEnvironment;
      assert.equal(environment.PI_AGY_BRIDGE_MCP_NODE, process.execPath);
      assert.equal(environment.PI_AGY_BRIDGE_MCP_ENDPOINT, bridge.bridgeUri);
      const bridgeUri = new URL(bridge.bridgeUri);
      assert.equal(bridgeUri.protocol, "unix:");
      assert.equal(bridgeUri.searchParams.get("session"), bridge.sessionId);

      child = spawn("sh", ["-c", 'exec "$PI_AGY_BRIDGE_MCP_NODE" "$PI_AGY_BRIDGE_MCP_ENTRYPOINT" --endpoint "$PI_AGY_BRIDGE_MCP_ENDPOINT"'], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ...environment,
        },
      });
      const responses = collectResponses(child);
      await bridge.waitForConnection();

      send(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      await responses.waitFor(1);
      send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
      send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

      const listed = await responses.waitFor(2) as any;
      assert.deepEqual(listed.result.tools.map((tool: any) => tool.name), ["read"]);

      let relayedCall: any;
      bridge.setToolCallHandler((batch) => {
        relayedCall = batch.calls[0];
      });
      send(child, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "read", arguments: { path: "README.md" } },
      });
      await waitFor(() => relayedCall !== undefined);

      assert.equal(relayedCall.name, "read");
      assert.deepEqual(relayedCall.arguments, { path: "README.md" });
      bridge.resolveToolResults([{
        role: "toolResult",
        toolCallId: relayedCall.id,
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
        isError: false,
        timestamp: Date.now(),
      }]);

      const called = await responses.waitFor(3) as any;
      assert.deepEqual(called.result, {
        content: [{ type: "text", text: "contents" }],
        isError: false,
      });
    } finally {
      child?.kill("SIGKILL");
      await bridge.close();
    }
  });

  it("rejects a second MCP client for the same Pi session", async (t) => {
    const bridge = new AgyMcpServer([]);
    try {
      try {
        await bridge.start();
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM") {
          t.skip("Unix domain sockets are unavailable in this sandbox");
          return;
        }
        throw error;
      }

      const first = await connectBridge(parseBridgeUri(bridge.bridgeUri));
      await assert.rejects(
        connectBridge(parseBridgeUri(bridge.bridgeUri)),
        /already has an active MCP client/
      );
      first.close();
    } finally {
      await bridge.close();
    }
  });

  it("cleans orphaned sockets and preserves active or non-socket files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pab-orphan-test-"));
    const deadChild = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise((resolve) => deadChild.on("exit", resolve));
    const deadPid = deadChild.pid!;

    const cases = [
      { name: `${deadPid}-abcdef123456.sock`, shouldExist: false },
      { name: `${process.pid}-abcdef123456.sock`, shouldExist: true },
      { name: "not-a-socket.txt", shouldExist: true },
      { name: "invalid-name.sock", shouldExist: true },
    ];

    try {
      for (const { name } of cases) {
        await fs.writeFile(path.join(tempDir, name), "");
      }

      await cleanOrphanSockets(tempDir);

      for (const { name, shouldExist } of cases) {
        const exists = await fs.access(path.join(tempDir, name)).then(() => true, () => false);
        assert.equal(exists, shouldExist, `File ${name} existence should be ${shouldExist}`);
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("handles missing directory in cleanOrphanSockets gracefully", async () => {
    const nonExistentDir = path.join(os.tmpdir(), `pab-non-existent-${Date.now()}`);
    await assert.doesNotReject(() => cleanOrphanSockets(nonExistentDir));
  });

  for (const action of ["close", "exit"] as const) {
    it(`removes the socket on ${action} and unregisters its exit hook on close`, async (t) => {
      const bridge = new AgyMcpServer([]);
      const listenersBefore = process.listeners("exit");
      t.after(() => bridge.close());

      try {
        await bridge.start();
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM") {
          t.skip("Unix domain sockets are unavailable in this sandbox");
          return;
        }
        throw error;
      }

      const endpoint = parseBridgeUri(bridge.bridgeUri).endpoint;
      await fs.access(endpoint);
      const addedListeners = process.listeners("exit").filter((listener) => !listenersBefore.includes(listener));
      assert.equal(addedListeners.length, 1);

      if (action === "exit") addedListeners[0]!(0);
      else await bridge.close();

      await assert.rejects(fs.access(endpoint), { code: "ENOENT" });
      await bridge.close();
      assert.deepEqual(process.listeners("exit"), listenersBefore);
    });
  }

  for (const [bridgeUri, expectedError] of [
    ["not-a-uri", "Bridge URI must be a valid unix: URI"],
    ["unix:///tmp/pi.sock", "Bridge URI must use unix:///absolute/socket/path?session=<session-id>"],
  ] as const) {
    it(`fails clearly for invalid MCP command endpoint ${JSON.stringify(bridgeUri)}`, async () => {
      const scriptPath = fileURLToPath(new URL("../../mcp/index.js", import.meta.url));
      const child = spawn("sh", ["-c", 'exec "$PI_AGY_BRIDGE_MCP_NODE" "$PI_AGY_BRIDGE_MCP_ENTRYPOINT" --endpoint "$PI_AGY_BRIDGE_MCP_ENDPOINT"'], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PI_AGY_BRIDGE_MCP_NODE: process.execPath,
          PI_AGY_BRIDGE_MCP_ENTRYPOINT: scriptPath,
          PI_AGY_BRIDGE_MCP_ENDPOINT: bridgeUri,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });

      assert.equal(code, 1);
      assert.equal(stdout, "");
      assert.ok(stderr.includes(expectedError), stderr);
    });
  }
});

function send(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function collectResponses(child: ChildProcessWithoutNullStreams): {
  waitFor(id: number): Promise<unknown>;
} {
  let buffer = "";
  const messages = new Map<number, unknown>();
  const waiters = new Map<number, (message: unknown) => void>();

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;

      const message = JSON.parse(line) as { id?: number };
      if (typeof message.id !== "number") continue;
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter(message);
      } else {
        messages.set(message.id, message);
      }
    }
  });

  return {
    waitFor(id) {
      const message = messages.get(id);
      if (message !== undefined) {
        messages.delete(id);
        return Promise.resolve(message);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for MCP response ${id}`)), 5_000);
        waiters.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for relayed MCP tool call");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
