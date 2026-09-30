import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { LiveSession, PiContextAdapter } from "./session.ts";
import { debugLog } from "../shared/debug.ts";

const ENTRY_TYPE = "pi-agy-bridge.runtime-session";

export interface AgyRuntimeSessionRef {
  conversationId: string;
  syncedEntryId?: string;
  historyHash?: string;
  historyLength?: number;
}

export class RuntimeSessionStore {
  private readonly piContext: PiContextAdapter;

  constructor(piContext: PiContextAdapter) {
    this.piContext = piContext;
  }

  public async get(piSessionId: string): Promise<AgyRuntimeSessionRef | undefined> {
    const sessionManager = this.piContext.getSessionManager(piSessionId);
    if (!sessionManager) return undefined;

    const branch = sessionManager.getBranch();
    let entry: Extract<SessionEntry, { type: "custom" }> | undefined;
    for (let index = branch.length - 1; index >= 0; index--) {
      const candidate = branch[index];
      if (candidate && isRuntimeSessionEntry(candidate)) {
        entry = candidate;
        break;
      }
    }
    if (!entry || !isRecord(entry.data)) return undefined;
    if (entry.data.deleted === true) return undefined;
    if (typeof entry.data.conversationId !== "string") return undefined;

    return {
      conversationId: entry.data.conversationId,
      syncedEntryId: entry.id,
      ...(typeof entry.data.historyHash === "string" ? { historyHash: entry.data.historyHash } : {}),
      ...(typeof entry.data.historyLength === "number" ? { historyLength: entry.data.historyLength } : {}),
    };
  }

  public async set(
    piSessionId: string,
    ref: AgyRuntimeSessionRef,
    canonicalHistory: readonly unknown[]
  ): Promise<AgyRuntimeSessionRef> {
    const sessionManager = this.requireSessionManager(piSessionId);
    const historyHash = hashHistory(canonicalHistory);
    const historyLength = canonicalHistory.length;
    const syncedEntryId = sessionManager.appendCustomEntry(ENTRY_TYPE, {
      conversationId: ref.conversationId,
      historyHash,
      historyLength,
    });

    return { conversationId: ref.conversationId, syncedEntryId, historyHash, historyLength };
  }

  public async delete(piSessionId: string): Promise<void> {
    this.requireSessionManager(piSessionId).appendCustomEntry(ENTRY_TYPE, { deleted: true });
  }

  private requireSessionManager(piSessionId: string) {
    const sessionManager = this.piContext.getSessionManager(piSessionId);
    if (!sessionManager) throw new Error(`Pi session ${piSessionId} is not attached to the bridge`);
    return sessionManager;
  }
}

export function historyMatches(ref: AgyRuntimeSessionRef, history: readonly unknown[]): boolean {
  if (ref.historyHash === undefined || ref.historyLength === undefined) return false;
  if (history.length < ref.historyLength) return false;
  return hashHistory(history.slice(0, ref.historyLength)) === ref.historyHash;
}

function hashHistory(history: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(history)).digest("hex");
}

function isRuntimeSessionEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "custom" }> {
  return entry.type === "custom" && entry.customType === ENTRY_TYPE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type RuntimeSessionDecision =
  | { action: "continue" }
  | { action: "resume"; conversationId: string }
  | { action: "rebuild" };

export interface RuntimeSessionSyncInput {
  syncKey: string;
  turnIndex: number;
  conversationId?: string;
  canonicalHistory: readonly unknown[];
  runtimeRef?: AgyRuntimeSessionRef;
}

export class RuntimeSessionSync {
  private readonly canonicalHistories = new WeakMap<LiveSession, string[]>();

  public decide(session: LiveSession, input: RuntimeSessionSyncInput): RuntimeSessionDecision {
    if (this.matchesLiveSession(session, input)) {
      if (session.activeProcess?.isRunning) return { action: "continue" };
      if (session.conversationId) {
        return { action: "resume", conversationId: session.conversationId };
      }
    }

    const ref = input.runtimeRef;
    if (ref && this.matchesPersistedSession(ref, input)) {
      return { action: "resume", conversationId: ref.conversationId };
    }

    debugLog("session", "Rebuilding AGY runtime instead of reusing", {
      syncKeyMatches: session.syncKey === input.syncKey,
      sessionTurnIndex: session.turnIndex,
      inputTurnIndex: input.turnIndex,
      sessionConversationId: session.conversationId,
      inputConversationId: input.conversationId,
      processRunning: session.activeProcess?.isRunning ?? false,
      hasRuntimeRef: ref !== undefined,
      runtimeRefMatches: ref ? this.matchesPersistedSession(ref, input) : false,
    });

    return { action: "rebuild" };
  }

  public record(
    session: LiveSession,
    messages: readonly unknown[],
    assistantMessage?: unknown
  ): void {
    const history = messages.map((message) => JSON.stringify(message));
    if (assistantMessage !== undefined) history.push(JSON.stringify(assistantMessage));
    this.canonicalHistories.set(session, history);
  }

  private matchesLiveSession(session: LiveSession, input: RuntimeSessionSyncInput): boolean {
    if (session.syncKey !== input.syncKey || session.turnIndex !== input.turnIndex) return false;
    if (!this.matchesConversationId(session.conversationId, input.conversationId)) return false;

    const previousHistory = this.canonicalHistories.get(session);
    if (!previousHistory) return true;
    if (input.canonicalHistory.length < previousHistory.length) return false;

    return previousHistory.every((entry, index) => entry === JSON.stringify(input.canonicalHistory[index]));
  }

  private matchesPersistedSession(
    ref: AgyRuntimeSessionRef,
    input: RuntimeSessionSyncInput
  ): boolean {
    return (
      this.matchesConversationId(ref.conversationId, input.conversationId) &&
      historyMatches(ref, input.canonicalHistory)
    );
  }

  private matchesConversationId(
    expected: string | undefined,
    actual: string | undefined
  ): boolean {
    return expected === undefined || actual === undefined || expected === actual;
  }
}
