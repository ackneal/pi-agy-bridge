import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import { AgyMcpServer, cleanOrphanSockets } from "../src/bridge-ipc.ts";
import { connectBridge, parseBridgeUri } from "../mcp/socket.js";

describe("AgyMcpServer", () => {
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
      assert.deepEqual(Object.keys(environment), ["PI_AGY_BRIDGE_MCP_COMMAND"]);
      assert.match(environment.PI_AGY_BRIDGE_MCP_COMMAND!, /--endpoint/);
      const bridgeUri = new URL(bridge.bridgeUri);
      assert.equal(bridgeUri.protocol, "unix:");
      assert.equal(bridgeUri.searchParams.get("session"), bridge.sessionId);

      const scriptPath = fileURLToPath(new URL("../mcp/index.js", import.meta.url));
      child = spawn("sh", ["-c", "exec $PI_AGY_BRIDGE_MCP_COMMAND"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PI_AGY_BRIDGE_MCP_COMMAND: `${process.execPath} ${scriptPath} --endpoint ${bridge.bridgeUri}`,
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

  it("registers exit hook on start and unregisters on close", async (t) => {
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

      const exitListenersBefore = process.listeners("exit");
      assert.ok(exitListenersBefore.length > 0);

      const endpoint = parseBridgeUri(bridge.bridgeUri).endpoint;
      const existsBefore = await fs.access(endpoint).then(() => true, () => false);
      assert.equal(existsBefore, true);

      await bridge.close();

      const exitListenersAfter = process.listeners("exit");
      assert.equal(exitListenersAfter.length, exitListenersBefore.length - 1);

      const existsAfter = await fs.access(endpoint).then(() => true, () => false);
      assert.equal(existsAfter, false);
    } finally {
      await bridge.close();
    }
  });

  it("unlinks socket file synchronously when exit listener is executed", async (t) => {
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

      const endpoint = parseBridgeUri(bridge.bridgeUri).endpoint;
      const existsBefore = await fs.access(endpoint).then(() => true, () => false);
      assert.equal(existsBefore, true);

      const listeners = process.listeners("exit");
      const lastListener = listeners[listeners.length - 1] as () => void;
      lastListener();

      const existsAfter = await fs.access(endpoint).then(() => true, () => false);
      assert.equal(existsAfter, false);
    } finally {
      await bridge.close();
    }
  });

  for (const [bridgeUri, expectedError] of [
    ["not-a-uri", "Bridge URI must be a valid unix: URI"],
    ["unix:///tmp/pi.sock", "Bridge URI must use unix:///absolute/socket/path?session=<session-id>"],
  ] as const) {
    it(`fails clearly for invalid MCP command endpoint ${JSON.stringify(bridgeUri)}`, async () => {
      const scriptPath = fileURLToPath(new URL("../mcp/index.js", import.meta.url));
      const child = spawn("sh", ["-c", "exec $PI_AGY_BRIDGE_MCP_COMMAND"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PI_AGY_BRIDGE_MCP_COMMAND: `${process.execPath} ${scriptPath} --endpoint ${bridgeUri}`,
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
