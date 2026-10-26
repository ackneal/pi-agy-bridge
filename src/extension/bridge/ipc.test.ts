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
import { AgyMcpServer, cleanOrphanSockets } from "./ipc.ts";
import { connectBridge, parseBridgeUri } from "../../mcp/socket.js";

describe("AgyMcpServer", () => {
  it("rejects platforms without UID support before touching the filesystem", async (t) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    const bridge = new AgyMcpServer([]);
    t.after(async () => {
      if (descriptor) Object.defineProperty(process, "getuid", descriptor);
      else Reflect.deleteProperty(process, "getuid");
      await bridge.close();
    });
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    t.mock.method(fs, "mkdir", () => assert.fail("Unsupported platforms must not create a runtime directory"));

    await assert.rejects(bridge.start(), /requires a platform with UID support/);
    assert.throws(() => bridge.bridgeUri, /not been started/);
  });

  for (const phase of ["mkdir", "listen", "chmod", "failure"] as const) {
    it(`serializes concurrent starts and close during ${phase}`, async (t) => {
      const bridge = new AgyMcpServer([]);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pab-serialization-test-"));
      t.after(async () => {
        try {
          release();
          await bridge.close();
        } finally {
          t.mock.restoreAll();
          syncBuiltinESMExports();
          await fs.rm(tempDir, { recursive: true, force: true });
        }
      });
      const runtimeStat = await fs.stat(tempDir);
      const exitListeners = process.listeners("exit");
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

      t.mock.method(net, "createServer", () => { created++; return server; });
      syncBuiltinESMExports();
      t.mock.method(fs, "mkdir", async () => {
        if (phase === "mkdir") {
          reached();
          await gate;
        }
      });
      t.mock.method(fs, "lstat", async () => runtimeStat);
      t.mock.method(fs, "readdir", async () => []);
      t.mock.method(fs, "chmod", async (target: string) => {
        if (!target.endsWith(".sock")) return;
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

  for (const kind of ["new", "permissive", "symlink", "file", "foreign-owner", "chmod-failure"] as const) {
    it(`secures the per-user runtime directory: ${kind}`, async (t) => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pab-runtime-test-"));
      const runtimeDir = path.join(tempDir, `pab-${process.getuid!()}`);
      const bridge = new AgyMcpServer([]);
      t.after(async () => {
        await bridge.close();
        t.mock.restoreAll();
        syncBuiltinESMExports();
        await fs.rm(tempDir, { recursive: true, force: true });
      });
      t.mock.method(os, "tmpdir", () => tempDir);
      const server = Object.assign(new EventEmitter(), {
        listening: false,
        listen(endpoint: string, callback: () => void) {
          void fs.writeFile(endpoint, "").then(() => {
            server.listening = true;
            callback();
          }).catch((error) => server.emit("error", error));
        },
        close(callback: () => void) { server.listening = false; callback(); },
      });
      t.mock.method(net, "createServer", () => server);
      syncBuiltinESMExports();

      if (kind === "symlink") {
        const target = path.join(tempDir, "target");
        await fs.mkdir(target, { mode: 0o755 });
        await fs.symlink(target, runtimeDir);
      } else if (kind === "file") {
        await fs.writeFile(runtimeDir, "");
      } else if (kind !== "new") {
        await fs.mkdir(runtimeDir);
        await fs.chmod(runtimeDir, 0o755);
      }
      if (kind === "foreign-owner") {
        const stat = await fs.lstat(runtimeDir);
        stat.uid = process.getuid!() + 1;
        t.mock.method(fs, "lstat", async () => stat);
      }
      if (kind === "chmod-failure") {
        t.mock.method(fs, "chmod", async () => { throw new Error("runtime chmod failed"); });
      }
      const readdir = fs.readdir.bind(fs);
      let cleaned = false;
      t.mock.method(fs, "readdir", async (directory: string) => {
        assert.equal(directory, runtimeDir);
        const stat = await fs.lstat(directory);
        assert.ok(stat.isDirectory());
        assert.equal(stat.uid, process.getuid!());
        assert.equal(stat.mode & 0o777, 0o700);
        cleaned = true;
        return readdir(directory);
      });

      if (kind === "new" || kind === "permissive") {
        await bridge.start();
        assert.equal(path.dirname(parseBridgeUri(bridge.bridgeUri).endpoint), runtimeDir);
        assert.equal((await fs.lstat(runtimeDir)).mode & 0o777, 0o700);
        assert.equal(cleaned, true);
      } else {
        const expected = kind === "file" ? /EEXIST/ : kind === "chmod-failure"
          ? /runtime chmod failed/ : /actual directory owned by the current user/;
        await assert.rejects(bridge.start(), expected);
        assert.equal(cleaned, false);
        assert.throws(() => bridge.bridgeUri, /not been started/);
      }
    });
  }

  for (const blank of ["\n", "\r\n", " \t\n", " \t\r\n"] as const) {
    it(`preserves the connection across blank lines ${JSON.stringify(blank)}`, async (t) => {
      const bridge = new AgyMcpServer([{ name: "read", description: "Read", parameters: Type.Object({}) }]);
      t.after(() => bridge.close());
      const writes: string[] = [];
      const socket = Object.assign(new EventEmitter(), {
        destroyed: false,
        write(data: string) { writes.push(data); return true; },
        end: () => assert.fail("Rejected message"),
        destroy() { this.destroyed = true; socket.emit("close"); },
      });
      let relayed = false;
      bridge.setToolCallHandler(() => { relayed = true; });
      (bridge as unknown as { handleConnection(socket: Socket): void }).handleConnection(socket as unknown as Socket);

      const wire = blank + JSON.stringify({ type: "hello", sessionId: bridge.sessionId }) + "\r\n" + blank +
        JSON.stringify({ type: "call", id: "1", name: "read", arguments: {} }) + "\r\n" + blank;
      for (const byte of Buffer.from(wire)) socket.emit("data", Buffer.from([byte]));
      await waitFor(() => relayed);

      assert.equal(socket.destroyed, false);
      assert.equal(JSON.parse(writes[0]!).type, "tools");
      assert.equal(bridge.hasPendingCalls, true);
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
      const uri = bridge.bridgeUri;
      const bridgeUri = new URL(uri);
      assert.equal(bridgeUri.protocol, "unix:");
      assert.equal(bridgeUri.searchParams.get("session"), bridge.sessionId);
      assert.equal(parseBridgeUri(uri).endpoint, bridgeUri.pathname);

      child = spawn(process.execPath, [fileURLToPath(new URL("../../mcp/index.js", import.meta.url)), "--endpoint", uri], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const responses = collectResponses(child);

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
      }], "context appendix");

      const called = await responses.waitFor(3) as any;
      assert.deepEqual(called.result, {
        content: [{ type: "text", text: "contents" }, { type: "text", text: "context appendix" }],
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
      const child = spawn("sh", ["-c", 'exec "$PI_AGY_BRIDGE_MCP_RUNTIME" "$PI_AGY_BRIDGE_MCP_ENTRYPOINT" --endpoint "$PI_AGY_BRIDGE_MCP_ENDPOINT"'], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PI_AGY_BRIDGE_MCP_RUNTIME: process.execPath,
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

for (const { phase, expectedError, expectedWrites } of [
  { phase: "destroyed", expectedError: /^Pi MCP result socket was destroyed before write\.$/, expectedWrites: 0 },
  { phase: "disconnect", expectedError: /^Pi MCP proxy disconnected before tool results were written\.$/, expectedWrites: 0 },
  { phase: "callback", expectedError: /^async write failed$/, expectedWrites: 1 },
  { phase: "serialization", expectedError: /serialize a BigInt/i, expectedWrites: 0 },
  { phase: "success", expectedError: null, expectedWrites: 1 },
  { phase: "idle", expectedError: null, expectedWrites: 0 },
] as const) {
  it(`handles owed result transport: ${phase}`, async (t) => {
    const bridge = new AgyMcpServer([]);
    t.after(() => bridge.close());
    const resultWrites: string[] = [];
    const socket = Object.assign(new EventEmitter(), {
      destroyed: false,
      write(data: string, callback?: (error?: Error) => void) {
        if (callback) {
          resultWrites.push(data);
          queueMicrotask(() => callback(phase === "callback" ? new Error("async write failed") : undefined));
        }
        return true;
      },
      destroy() { this.destroyed = true; },
      end() {},
    });
    const failures: Error[] = [];
    bridge.setTransportFailureHandler((error) => failures.push(error));
    const internals = bridge as unknown as {
      handleConnection(socket: Socket): void;
      gateway: { call(): Promise<unknown> };
    };
    let resolve!: (result: unknown) => void;
    internals.gateway.call = () => new Promise((done) => { resolve = done; });
    internals.handleConnection(socket as unknown as Socket);
    socket.emit("data", Buffer.from(`${JSON.stringify({ type: "hello", sessionId: bridge.sessionId })}\n`));

    if (phase === "idle") {
      socket.emit("close");
    } else {
      socket.emit("data", Buffer.from('{"type":"call","id":"one","name":"tool"}\n'));
      if (phase === "destroyed" || phase === "disconnect") socket.destroy();
      if (phase === "disconnect") {
        socket.emit("close");
        assert.equal(failures.length, 1);
        assert.match(failures[0]!.message, expectedError);
      }
      resolve(phase === "serialization" ? { content: BigInt(1) } : { content: [] });
      await new Promise((done) => setImmediate(done));
    }

    assert.equal(resultWrites.length, expectedWrites);
    assert.equal(failures.length, expectedError ? 1 : 0);
    if (expectedError) assert.match(failures[0]!.message, expectedError);
    if (phase === "success") {
      assert.deepEqual(JSON.parse(resultWrites[0]!), { type: "result", id: "one", result: { content: [] } });
      socket.emit("close");
      assert.equal(failures.length, 0);
    }
    const replayed: Error[] = [];
    bridge.setTransportFailureHandler((error) => replayed.push(error));
    assert.deepEqual(replayed, failures);
  });
}
