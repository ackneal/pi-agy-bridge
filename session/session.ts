import { randomUUID } from "node:crypto";
import type { AgyRuntime } from "../runtime/process.ts";
import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { BridgeIPC } from "../bridge/bridge-ipc.ts";
import { debugLog } from "../shared/debug.ts";

export class TerminalRegistry {
  private readonly handles = new Map<string, string>();
  private readonly reverseHandles = new Map<string, string>();
  private nextId = 1;

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
  public activeProcess: AgyRuntime | null = null;
  public activeMcpServer: BridgeIPC | null = null;
  public syncKey: string = "";
  public turnIndex: number = 0;
  public conversationId: string | undefined;
  public readonly resources = new SessionResources();
  private abortSignal: AbortSignal | null = null;
  private abortListener: (() => void) | null = null;

  constructor(piSessionId: string) {
    this.piSessionId = piSessionId;
  }

  public setSession(
    process: AgyRuntime,
    syncKey: string,
    mcpServer?: BridgeIPC,
    conversationId?: string
  ): void {
    this.activeProcess = process;
    this.activeMcpServer = mcpServer ?? null;
    this.syncKey = syncKey;
    this.turnIndex = 0;
    this.conversationId = conversationId;
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

  public incrementTurn(): void {
    this.turnIndex++;
  }

  public async dispose(): Promise<void> {
    const proc = this.activeProcess;
    const mcpServer = this.activeMcpServer;

    this.activeProcess = null;
    this.activeMcpServer = null;
    this.syncKey = "";
    this.turnIndex = 0;
    this.conversationId = undefined;
    this.clearAbortSignal();
    this.resources.disposeAll();

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
