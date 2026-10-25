import type { DriverId, DriverSession, RuntimeEvent } from "../drivers/types.ts";
import { randomUUID } from "node:crypto";
import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { BridgeIPC } from "../bridge/bridge-ipc.ts";
import { debugLog } from "../shared/debug.ts";

export class TerminalRegistry {
  private readonly handles = new Map<string, string>();
  private readonly reverseHandles = new Map<string, string>();
  private nextId = 1;

  public get size(): number {
    return this.handles.size;
  }

  public bind(piPtyId: string): string {
    const existing = this.reverseHandles.get(piPtyId);
    if (existing) return existing;

    const handle = `terminal-${this.nextId++}`;
    this.handles.set(handle, piPtyId);
    this.reverseHandles.set(piPtyId, handle);
    return handle;
  }

  public resolve(handle: string): string | undefined {
    return this.handles.get(handle);
  }

  public toHandle(piPtyId: string): string | undefined {
    return this.reverseHandles.get(piPtyId);
  }

  public release(handle: string): void {
    const piPtyId = this.handles.get(handle);
    if (!piPtyId) return;
    this.handles.delete(handle);
    this.reverseHandles.delete(piPtyId);
  }

  public disposeAll(): void {
    this.handles.clear();
    this.reverseHandles.clear();
    this.nextId = 1;
  }
}

export class SessionResources {
  public readonly terminals = new TerminalRegistry();

  public disposeAll(): void {
    this.terminals.disposeAll();
  }
}

export class PiContextAdapter {
  private readonly sessions = new Map<string, SessionManager>();

  public bind(sessionManager: ExtensionContext["sessionManager"]): string {
    const sessionId = sessionManager.getSessionId();
    this.sessions.set(sessionId, sessionManager as SessionManager);
    return sessionId;
  }

  public getSessionManager(sessionId: string): SessionManager | undefined {
    const sessionManager = this.sessions.get(sessionId);
    return sessionManager?.getSessionId() === sessionId ? sessionManager : undefined;
  }

  public clear(): void {
    this.sessions.clear();
  }
}

export function calculateSyncKey(
  systemPrompt: string = "",
  toolSignatures: readonly string[] = [],
  model: string = "",
  effort: string = "",
  agentName: string = ""
): string {
  const sortedTools = [...toolSignatures].sort().join(",");
  const effortPart = effort ? `::${effort}` : "";
  const agentPart = agentName ? `::${agentName}` : "";

  return `${systemPrompt}::${sortedTools}::${model}${effortPart}${agentPart}`;
}

export class LiveSession {
  public readonly id = randomUUID();
  public readonly piSessionId: string;
  public activeProcess: DriverSession | null = null;
  public driverId: DriverId = "cli";
  public activeMcpServer: BridgeIPC | null = null;
  public syncKey: string = "";
  public conversationId: string | undefined;
  public instructionKey: string | undefined;
  public readonly resources = new SessionResources();
  private unsubscribeRuntimeEvents: (() => void) | null = null;
  private abortSignal: AbortSignal | null = null;
  private abortListener: (() => void) | null = null;
  private preparationId: symbol | undefined;
  private disposal: Promise<void> | undefined;

  constructor(piSessionId: string) {
    this.piSessionId = piSessionId;
  }

  public beginPreparation(): symbol {
    const preparationId = Symbol();
    this.preparationId = preparationId;
    return preparationId;
  }

  public ownsPreparation(token: symbol): boolean {
    return this.preparationId === token;
  }

  public releasePreparation(token: symbol): void {
    if (this.ownsPreparation(token)) this.preparationId = undefined;
  }

  public setSession(
    process: DriverSession,
    syncKey: string,
    mcpServer?: BridgeIPC,
    conversationId?: string,
    preparationId?: symbol
  ): boolean {
    if (preparationId !== undefined && !this.ownsPreparation(preparationId)) return false;

    this.activeProcess = process;
    this.driverId = process.driver;
    this.activeMcpServer = mcpServer ?? null;
    this.syncKey = syncKey;
    this.conversationId = conversationId;
    this.instructionKey = process.instructionKey;
    return true;
  }

  public setRuntimeEventHandler(handler: ((event: RuntimeEvent) => void) | null): void {
    const unsubscribe = this.unsubscribeRuntimeEvents;
    this.unsubscribeRuntimeEvents = null;
    unsubscribe?.();

    if (handler && this.activeProcess) {
      this.unsubscribeRuntimeEvents = this.activeProcess.onRuntimeEvent(handler);
    }
  }

  public setAbortSignal(signal: AbortSignal | undefined, onAbort: () => void): void {
    this.clearAbortSignal();
    if (!signal) return;

    this.abortSignal = signal;
    this.abortListener = onAbort;
    signal.addEventListener("abort", onAbort, { once: true });
  }

  public clearAbortSignal(): void {
    if (this.abortSignal && this.abortListener) {
      this.abortSignal.removeEventListener("abort", this.abortListener);
    }
    this.abortSignal = null;
    this.abortListener = null;
  }

  public async dispose(options?: { preserveResources?: boolean; preserveConversation?: boolean; preparationId?: symbol }): Promise<void> {
    if (options?.preparationId !== undefined) {
      if (!this.ownsPreparation(options.preparationId)) return;
    } else {
      this.preparationId = undefined;
    }

    const proc = this.activeProcess;
    const mcpServer = this.activeMcpServer;

    this.activeProcess = null;
    this.activeMcpServer = null;
    this.syncKey = "";
    if (!options?.preserveConversation) {
      this.conversationId = undefined;
      this.instructionKey = undefined;
    }
    this.clearAbortSignal();
    this.setRuntimeEventHandler(null);
    if (!options?.preserveResources) this.resources.disposeAll();

    const previousDisposal = this.disposal;
    const disposal = (async () => {
      // Abort listeners can start disposal before registry cleanup reaches us.
      if (previousDisposal) await previousDisposal;

      if (mcpServer) {
        try {
          await mcpServer.close();
        } catch (err) {
          debugLog("session", "Error closing Pi MCP server during reset:", err);
        }
      }

      if (proc) {
        debugLog("session", "Disposing session: aborting active process");
        try {
          await proc.abort();
        } catch (err) {
          debugLog("session", "Error aborting active process during reset:", err);
        }
      }
    })();
    this.disposal = disposal;

    try {
      await disposal;
    } finally {
      if (this.disposal === disposal) this.disposal = undefined;
    }
  }
}

export class LiveSessionRegistry {
  private readonly sessions = new Map<string, LiveSession>();

  public get(piSessionId: string): LiveSession | undefined {
    return this.sessions.get(piSessionId);
  }

  public getOrCreate(piSessionId: string): LiveSession {
    let session = this.sessions.get(piSessionId);
    if (!session) {
      session = new LiveSession(piSessionId);
      this.sessions.set(piSessionId, session);
    }
    return session;
  }

  public async remove(piSessionId: string): Promise<void> {
    const session = this.sessions.get(piSessionId);
    if (!session) return;

    this.sessions.delete(piSessionId);
    await session.dispose();
  }

  public async disposeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.dispose()));
  }
}
