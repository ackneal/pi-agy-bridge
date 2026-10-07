import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { LiveSession, PiContextAdapter } from "./session.ts";
import { debugLog, isDebugEnabled } from "../shared/debug.ts";

import { HISTORY_FORMAT, serializeHistoryMessage } from "./history.ts";

const ENTRY_TYPE = "pi-agy-bridge.runtime-session";

export interface AgyRuntimeSessionRef {
  conversationId: string;
  syncedEntryId?: string;
  historyHash?: string;
  historyLength?: number;
  historyFormat?: string;
}

export class RuntimeSessionStore {
  private readonly piContext: PiContextAdapter;

  constructor(piContext: PiContextAdapter) {
    this.piContext = piContext;
  }

  public async get(piSessionId: string, loginEpoch?: string): Promise<AgyRuntimeSessionRef | undefined> {
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
    if (entry.data.deleted === true || entry.data.loginEpoch !== loginEpoch) return undefined;
    if (typeof entry.data.conversationId !== "string") return undefined;

    return {
      conversationId: entry.data.conversationId,
      syncedEntryId: entry.id,
      ...(typeof entry.data.historyFormat === "string" ? { historyFormat: entry.data.historyFormat } : {}),
      ...(typeof entry.data.historyHash === "string" ? { historyHash: entry.data.historyHash } : {}),
      ...(typeof entry.data.historyLength === "number" ? { historyLength: entry.data.historyLength } : {}),
    };
  }

  public async set(
    piSessionId: string,
    ref: AgyRuntimeSessionRef,
    canonicalHistory: readonly unknown[],
    loginEpoch?: string
  ): Promise<AgyRuntimeSessionRef> {
    const sessionManager = this.requireSessionManager(piSessionId);
    const historyHash = hashHistory(canonicalHistory);
    const historyLength = canonicalHistory.length;
    const syncedEntryId = sessionManager.appendCustomEntry(ENTRY_TYPE, {
      conversationId: ref.conversationId,
      ...(loginEpoch ? { loginEpoch } : {}),
      historyHash,
      historyLength,
      historyFormat: HISTORY_FORMAT,
    });

    return { conversationId: ref.conversationId, syncedEntryId, historyHash, historyLength, historyFormat: HISTORY_FORMAT };
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
  if (ref.historyFormat !== HISTORY_FORMAT) {
    debugLog("session", "Unsupported persisted history format", { format: ref.historyFormat, expected: HISTORY_FORMAT });
    return false;
  }
  if (ref.historyHash === undefined || ref.historyLength === undefined) return false;
  if (history.length < ref.historyLength) return false;
  const actualHash = hashHistory(history.slice(0, ref.historyLength));
  if (actualHash !== ref.historyHash) {
    debugLog("session", "Persisted history mismatch", {
      expectedHash: ref.historyHash,
      actualHash,
      expectedLength: ref.historyLength,
      actualLength: history.length,
    });
  }
  return actualHash === ref.historyHash;
}

function hashHistory(history: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(history.map(serializeHistoryMessage))).digest("hex");
}

function isRuntimeSessionEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "custom" }> {
  return entry.type === "custom" && entry.customType === ENTRY_TYPE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function changedFields(expected: unknown, actual: unknown, prefix = "", depth = 0): string[] {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return [];
  if (depth >= 4 || !isRecord(expected) || !isRecord(actual)) return [prefix || "$"];

  const fields: string[] = [];
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    fields.push(...changedFields(expected[key], actual[key], prefix ? `${prefix}.${key}` : key, depth + 1));
    if (fields.length >= 20) return fields.slice(0, 20);
  }
  return fields;
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
    // Validate even newly appended messages before continuing an existing runtime.
    input.canonicalHistory.forEach(serializeHistoryMessage);

    if (this.matchesLiveSession(session, input)) {
      if (session.activeProcess?.isRunning) return { action: "continue" };
      if (session.conversationId) {
        return { action: "resume", conversationId: session.conversationId };
      }
    }

    const ref = input.runtimeRef;
    if (ref && this.matchesPersistedSession(ref, input)) {
      this.record(session, input.canonicalHistory.slice(0, ref.historyLength));
      return { action: "resume", conversationId: ref.conversationId };
    }

    debugLog("session", "Rebuilding Antigravity CLI runtime instead of reusing", {
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

  public getSyncedMessageCount(session: LiveSession): number | undefined {
    return this.canonicalHistories.get(session)?.length;
  }

  public record(
    session: LiveSession,
    messages: readonly unknown[],
    assistantMessage?: unknown
  ): void {
    const history = messages.map(serializeHistoryMessage);
    if (assistantMessage !== undefined) history.push(serializeHistoryMessage(assistantMessage));
    this.canonicalHistories.set(session, history);
  }

  private matchesLiveSession(session: LiveSession, input: RuntimeSessionSyncInput): boolean {
    if (session.syncKey !== input.syncKey || session.turnIndex !== input.turnIndex) return false;
    if (!this.matchesConversationId(session.conversationId, input.conversationId)) return false;

    const previousHistory = this.canonicalHistories.get(session);
    if (!previousHistory) return true;
    if (input.canonicalHistory.length < previousHistory.length) {
      debugLog("session", "Live history shortened", {
        expectedLength: previousHistory.length,
        actualLength: input.canonicalHistory.length,
      });
      return false;
    }

    const mismatchIndex = previousHistory.findIndex((entry, index) =>
      entry !== serializeHistoryMessage(input.canonicalHistory[index])
    );
    if (mismatchIndex < 0) return true;

    if (isDebugEnabled()) {
      const expected: unknown = JSON.parse(previousHistory[mismatchIndex]!);
      const actual: unknown = JSON.parse(serializeHistoryMessage(input.canonicalHistory[mismatchIndex]));
      const fields = changedFields(expected, actual);
      debugLog("session", "Live history message mismatch", {
        index: mismatchIndex,
        expectedRole: isRecord(expected) ? expected.role : undefined,
        actualRole: isRecord(actual) ? actual.role : undefined,
        changedFields: fields,
        serializationOnly: fields.length === 0,
      });
    }
    return false;
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
