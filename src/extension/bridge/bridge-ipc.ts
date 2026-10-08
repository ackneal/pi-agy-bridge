import { createHash, randomBytes, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import type { JsonObject, Message, Tool } from "@earendil-works/pi-ai";
import { debugArtifact, debugLog, isDebugEnabled } from "../shared/debug.ts";
import { CapabilityGateway, type PiToolCallBatch } from "./capabilities.ts";
import type { SessionResources } from "../session/session.ts";
import { formatBridgeUri } from "../../mcp/socket.js";
import { resolveMcpEntrypoint } from "../discovery/plugin-install.ts";

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
  private transportFailureHandler: ((error: Error) => void) | null = null;
  private transportFailure: Error | null = null;
  private broker: Server | null = null;
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private socketPath: string | null = null;
  private exitListener: (() => void) | null = null;
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
      PI_AGY_BRIDGE_MCP_NODE: nodePath,
      PI_AGY_BRIDGE_MCP_ENTRYPOINT: entrypointPath,
      PI_AGY_BRIDGE_MCP_ENDPOINT: this.bridgeUri,
    };
  }

  public async waitForConnection(timeoutMs: number = 15_000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.connected,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Antigravity CLI did not connect to the Pi stdio MCP server")),
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

  public setTransportFailureHandler(handler: ((error: Error) => void) | null): void {
    this.transportFailureHandler = handler;
    if (handler && this.transportFailure) handler(this.transportFailure);
  }

  private failTransport(error: unknown): void {
    if (this.transportFailure) return;
    this.transportFailure = error instanceof Error ? error : new Error(String(error));
    this.transportFailureHandler?.(this.transportFailure);
  }

  public resolveToolResults(messages: readonly Message[], contextUpdate?: string): number {
    return this.gateway.resolveToolResults(messages, contextUpdate);
  }

  public async start(): Promise<void> {
    if (this.broker || this.startPromise || this.closePromise) {
      throw new Error("Pi MCP broker is already running");
    }

    this.startPromise = this.startBroker();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startBroker(): Promise<void> {
    const runtimeDir = path.join(os.tmpdir(), "pab");
    try {
      await fs.mkdir(runtimeDir, { recursive: true });
      await cleanOrphanSockets(runtimeDir);

      this.socketPath = path.join(
        runtimeDir,
        `${process.pid}-${randomBytes(6).toString("hex")}.sock`
      );
      this.broker = createServer((socket) => this.handleConnection(socket));

      const socketPath = this.socketPath;
      this.exitListener = () => {
        try {
          unlinkSync(socketPath);
        } catch {
          // Process is terminating; ignore unlinking errors.
        }
      };
      process.on("exit", this.exitListener);

      await listen(this.broker, this.socketPath);
      await fs.chmod(this.socketPath, 0o600);
      debugLog("mcp", `Pi MCP broker listening at ${this.socketPath} for session ${this.sessionId}`);
    } catch (error) {
      await this.disposeBroker();
      throw error;
    }
  }

  public async close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = (async () => {
        await this.startPromise?.catch(() => {});
        await this.disposeBroker();
      })();
    }

    try {
      await this.closePromise;
    } finally {
      this.closePromise = null;
    }
  }

  private async disposeBroker(): Promise<void> {
    this.cleanupExitListener();

    this.transportFailureHandler = null;
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
      const socketPath = this.socketPath;
      this.socketPath = null;
      await fs.unlink(socketPath).catch((error) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      });
    }
  }

  private cleanupExitListener(): void {
    if (this.exitListener) {
      process.removeListener("exit", this.exitListener);
      this.exitListener = null;
    }
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("error", (error) => {
      debugLog("mcp", "Pi MCP broker socket error:", error);
      socket.destroy();
    });
    socket.once("close", () => {
      this.sockets.delete(socket);
      const disconnectedCalls = [...this.resultSockets.entries()]
        .filter(([, resultSocket]) => resultSocket === socket)
        .map(([id]) => id);
      for (const id of disconnectedCalls) this.resultSockets.delete(id);

      if (disconnectedCalls.length > 0) {
        this.failTransport(new Error("Pi MCP proxy disconnected before tool results were written."));
      }
      if (!this.authenticatedSockets.delete(socket)) return;
      if (this.authenticatedSockets.size === 0 && disconnectedCalls.length > 0) {
        this.gateway.cancelPendingCalls("Pi MCP proxy disconnected during tool execution.");
      }
    });

    const decoder = new StringDecoder("utf8");
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;

        try {
          const message = JSON.parse(line) as BrokerMessage;
          if (!this.authenticatedSockets.has(socket)) {
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
          debugLog("mcp", "Broker call received", { brokerId: callId, name: toolName });
          void this.gateway.call(toolName, args).then((result) => {
            const payload = { type: "result", id: callId, result };
            if (socket.destroyed) throw new Error("Pi MCP result socket was destroyed before write.");
            const wireResult = `${JSON.stringify(payload)}\n`;
            if (isDebugEnabled()) {
              const content = JSON.stringify(result.content);
              debugLog("mcp", "Broker result ready", {
                brokerId: callId,
                name: toolName,
                contentBytes: Buffer.byteLength(content),
                contentHash: createHash("sha256").update(content).digest("hex"),
              });
              debugArtifact("mcp-wire-result", { sessionId: this.sessionId, name: toolName, payload });
            }
            socket.write(wireResult, (error) => {
              // A successful callback is a local write, not a remote acknowledgement.
              if (error) this.failTransport(error);
              this.resultSockets.delete(callId);
            });
          }).catch((error) => {
            this.failTransport(error);
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

export async function cleanOrphanSockets(runtimeDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(runtimeDir);
  } catch {
    return;
  }

  const socketPattern = /^(\d+)-[0-9a-f]+\.sock$/i;

  for (const entry of entries) {
    const match = socketPattern.exec(entry);
    if (!match) continue;

    const pid = Number.parseInt(match[1]!, 10);
    if (isPidAlive(pid)) continue;

    await fs.unlink(path.join(runtimeDir, entry)).catch((error) => {
      if (!isNodeError(error, "ENOENT")) {
        debugLog("mcp", `Failed to remove orphan socket ${entry}:`, error);
      }
    });
  }
}

function isPidAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isInteger(pid)) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}


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
