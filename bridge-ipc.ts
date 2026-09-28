import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type { JsonObject, Message, Tool } from "@earendil-works/pi-ai";
import { debugLog } from "./debug.ts";
import { CapabilityGateway, type PiToolCallBatch } from "./capabilities.ts";
import type { SessionResources } from "./session.ts";
import { formatBridgeUri } from "./mcp/socket.js";
import { resolveMcpEntrypoint } from "./plugin-install.ts";

interface BrokerMessage {
  type: string;
  sessionId?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

export class BridgeIPC {
  public readonly sessionId: string;
  private readonly gateway: CapabilityGateway;
  private readonly resultSockets = new Map<string, Socket>();
  private readonly sockets = new Set<Socket>();
  private readonly authenticatedSockets = new Set<Socket>();
  private broker: Server | null = null;
  private socketPath: string | null = null;
  private markConnected: (() => void) | null = null;
  private readonly connected = new Promise<void>((resolve) => {
    this.markConnected = resolve;
  });

  constructor(
    tools: readonly Tool[],
    sessionId: string = randomUUID(),
    resources?: SessionResources
  ) {
    this.sessionId = sessionId;
    debugLog("mcp", "BridgeIPC input tools:", tools.map((tool) => tool.name));
    this.gateway = new CapabilityGateway(tools, resources);
  }

  public get hasPendingCalls(): boolean {
    return this.gateway.hasPendingCalls;
  }

  public get bridgeUri(): string {
    if (!this.socketPath) throw new Error("Pi MCP bridge has not been started");
    return formatBridgeUri({
      endpoint: this.socketPath,
      sessionId: this.sessionId,
    });
  }

  public get processEnvironment(): NodeJS.ProcessEnv {
    const { nodePath, entrypointPath } = resolveMcpEntrypoint();
    return {
      PI_AGY_BRIDGE_MCP_COMMAND: [nodePath, entrypointPath, "--endpoint", this.bridgeUri].join(" "),
    };
  }

  public async waitForConnection(timeoutMs: number = 5_000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.connected,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("AgY did not connect to the Pi stdio MCP server")),
            timeoutMs
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  public setToolCallHandler(handler: ((batch: PiToolCallBatch) => void) | null): void {
    this.gateway.setToolCallHandler(handler);
  }

  public resolveToolResults(messages: readonly Message[]): number {
    return this.gateway.resolveToolResults(messages);
  }

  public async start(): Promise<void> {
    if (this.broker) throw new Error("Pi MCP broker is already running");

    const runtimeDir = path.join(os.tmpdir(), "pi-agy-bridge", "runtime");
    await fs.mkdir(runtimeDir, { recursive: true });

    this.socketPath = path.join(
      runtimeDir,
      `mcp-${process.pid}-${randomBytes(6).toString("hex")}.sock`
    );
    this.broker = createServer((socket) => this.handleConnection(socket));

    try {
      await listen(this.broker, this.socketPath);
      await fs.chmod(this.socketPath, 0o600);
      debugLog("mcp", `Pi MCP broker listening at ${this.socketPath} for session ${this.sessionId}`);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  public async close(): Promise<void> {
    this.gateway.setToolCallHandler(null);
    this.gateway.cancelPendingCalls("Pi MCP bridge closed before the tool result was returned.");

    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.resultSockets.clear();
    this.authenticatedSockets.clear();

    const broker = this.broker;
    this.broker = null;
    if (broker?.listening) await closeServer(broker);

    if (this.socketPath) {
      await fs.unlink(this.socketPath).catch((error) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      });
      this.socketPath = null;
    }
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => {
      this.sockets.delete(socket);
      const disconnectedCalls = [...this.resultSockets.entries()]
        .filter(([, resultSocket]) => resultSocket === socket)
        .map(([id]) => id);
      for (const id of disconnectedCalls) this.resultSockets.delete(id);

      if (!this.authenticatedSockets.delete(socket)) return;
      if (this.authenticatedSockets.size === 0 && disconnectedCalls.length > 0) {
        this.gateway.cancelPendingCalls("Pi MCP proxy disconnected during tool execution.");
      }
    });

    let buffer = "";
    let authenticated = false;

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;

        try {
          const message = JSON.parse(line) as BrokerMessage;
          if (!authenticated) {
            if (message.type !== "hello" || message.sessionId !== this.sessionId) {
              socket.end(`${JSON.stringify({
                type: "error",
                message: "Unknown or disposed Pi session",
              })}\n`);
              return;
            }

            if (this.authenticatedSockets.size > 0) {
              socket.end(`${JSON.stringify({
                type: "error",
                message: "This Pi session already has an active MCP client",
              })}\n`);
              return;
            }

            authenticated = true;
            this.authenticatedSockets.add(socket);
            this.markConnected?.();
            this.markConnected = null;
            socket.write(`${JSON.stringify({
              type: "tools",
              tools: this.gateway.list(),
            })}\n`);
            continue;
          }

          if (
            message.type !== "call" ||
            typeof message.id !== "string" ||
            message.id === "" ||
            typeof message.name !== "string" ||
            message.name === "" ||
            (message.arguments !== undefined && !isRecord(message.arguments))
          ) {
            socket.end(`${JSON.stringify({
              type: "error",
              message: "Invalid Pi MCP broker call",
            })}\n`);
            return;
          }
          if (this.resultSockets.has(message.id)) {
            socket.end(`${JSON.stringify({
              type: "error",
              message: `Duplicate Pi MCP broker call ID: ${message.id}`,
            })}\n`);
            return;
          }

          const callId = message.id;
          const toolName = message.name;
          const args = (message.arguments ?? {}) as JsonObject;
          this.resultSockets.set(callId, socket);
          void this.gateway.call(toolName, args).then((result) => {
            if (!socket.destroyed) {
              socket.write(`${JSON.stringify({ type: "result", id: callId, result })}\n`);
            }
            this.resultSockets.delete(callId);
          });
        } catch (error) {
          debugLog("mcp", "Invalid Pi MCP broker message:", error);
          socket.destroy();
        }
      }
    });
  }
}

export { BridgeIPC as AgyMcpServer };


function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
