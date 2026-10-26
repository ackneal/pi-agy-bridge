import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { LiveSession, PiContextAdapter } from "./session.ts";
import { debugLog, isDebugEnabled } from "../shared/debug.ts";

import { serializeMessage } from "./history.ts";

const ENTRY_TYPE = "pi-agy-bridge.runtime-session";

export interface AgyConversationCheckpoint {
  sessionId: string;
  version: string;
  fingerprint?: string;
  messageCount?: number;
  hasPendingToolCalls?: boolean;
  compatibilityKey?: string;
}

export class RuntimeSessionStore {
  private readonly piContext: PiContextAdapter;

  constructor(piContext: PiContextAdapter) {
    this.piContext = piContext;
  }

  public async get(piSessionId: string, loginEpoch: string | undefined, version: string): Promise<AgyConversationCheckpoint | undefined> {
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
    if (entry.data.version !== version || typeof version !== "string") return undefined;
    if (typeof entry.data.sessionId !== "string" || !entry.data.sessionId.trim()) return undefined;
    if (!soundHash(entry.data)) return undefined;
    if (entry.data.hasPendingToolCalls !== undefined && typeof entry.data.hasPendingToolCalls !== "boolean") return undefined;
    if (entry.data.compatibilityKey !== undefined && (typeof entry.data.compatibilityKey !== "string" || !/^[a-f0-9]{64}$/.test(entry.data.compatibilityKey))) return undefined;

    return {
      sessionId: entry.data.sessionId,
      version,
      fingerprint: entry.data.fingerprint as string,
      messageCount: entry.data.messageCount as number,
      ...(typeof entry.data.hasPendingToolCalls === "boolean" ? { hasPendingToolCalls: entry.data.hasPendingToolCalls } : {}),
      ...(typeof entry.data.compatibilityKey === "string" ? { compatibilityKey: entry.data.compatibilityKey } : {}),
    };
  }

  public async set(
    piSessionId: string,
    checkpoint: Omit<AgyConversationCheckpoint, "version">,
    messages: readonly unknown[],
    loginEpoch: string | undefined,
    version: string
  ): Promise<AgyConversationCheckpoint> {
    const sessionManager = this.requireSessionManager(piSessionId);
    if (!checkpoint.sessionId.trim()) throw new Error("Checkpoint session ID must be nonempty");
    const fingerprint = fingerprintSerializedMessages(messages.map(serializeMessage));
    const messageCount = messages.length;
    const pendingMetadata = typeof checkpoint.hasPendingToolCalls === "boolean" ? { hasPendingToolCalls: checkpoint.hasPendingToolCalls } : {};
    const compatibilityMetadata = checkpoint.compatibilityKey !== undefined ? { compatibilityKey: checkpoint.compatibilityKey } : {};
    sessionManager.appendCustomEntry(ENTRY_TYPE, {
      sessionId: checkpoint.sessionId,
      version,
      ...(loginEpoch !== undefined ? { loginEpoch } : {}),
      fingerprint,
      messageCount,
      ...pendingMetadata,
      ...compatibilityMetadata,
    });

    return {
      sessionId: checkpoint.sessionId, version, fingerprint, messageCount,
      ...pendingMetadata,
      ...compatibilityMetadata,
    };
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

function matchMessages(
  checkpoint: AgyConversationCheckpoint,
  messages: readonly unknown[],
  serializedMessages?: readonly string[]
): boolean {
  if (!soundHash(checkpoint)) return false;
  if (messages.length < checkpoint.messageCount!) return false;
  const actualFingerprint = fingerprintSerializedMessages(serializedMessages
    ? serializedMessages.slice(0, checkpoint.messageCount)
    : messages.slice(0, checkpoint.messageCount).map(serializeMessage));
  if (actualFingerprint !== checkpoint.fingerprint) {
    debugLog("session", "Persisted messages mismatch", {
      expectedFingerprint: checkpoint.fingerprint,
      actualFingerprint,
      expectedMessageCount: checkpoint.messageCount,
      actualMessageCount: messages.length,
    });
  }
  return actualFingerprint === checkpoint.fingerprint;
}

function soundHash(value: { fingerprint?: unknown; messageCount?: unknown }): boolean {
  return typeof value.messageCount === "number" && Number.isSafeInteger(value.messageCount) && value.messageCount >= 0 &&
    typeof value.fingerprint === "string" && /^[a-f0-9]{64}$/.test(value.fingerprint);
}

function fingerprintSerializedMessages(messages: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
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
  /** Settings changes can resume a conversation or wait for pending tool calls. */
  syncKey: string;
  compatibilityKey?: string;
  conversationId?: string;
  messages: readonly unknown[];
  checkpoint?: AgyConversationCheckpoint;
}

export class RuntimeSessionSync {
  private readonly syncedMessages = new WeakMap<LiveSession, string[]>();

  public decide(session: LiveSession, input: RuntimeSessionSyncInput): RuntimeSessionDecision {
    // Validate even newly appended messages before continuing an existing runtime.
    const serializedMessages = input.messages.map(serializeMessage);

    // A dead process cannot receive results for its outstanding MCP calls.
    const deadPendingRuntime = session.activeMcpServer?.hasPendingCalls && !session.activeProcess?.isRunning;
    const syncedCount = this.getSyncedMessageCount(session);

    const liveCompatibilityMatches = input.compatibilityKey === undefined || session.compatibilityKey === input.compatibilityKey;
    if (liveCompatibilityMatches && !deadPendingRuntime && this.matchesLiveSession(session, input, serializedMessages)) {
      if (session.activeProcess?.isRunning &&
        (session.syncKey === input.syncKey || session.activeMcpServer?.hasPendingCalls)) {
        return { action: "continue" };
      }
      if (session.conversationId) {
        return { action: "resume", conversationId: session.conversationId };
      }
    }

    const checkpoint = input.checkpoint;
    // An older checkpoint cannot roll back a conversation whose newer live
    // messages are already known. A different branch conversation may still resume.
    if (checkpoint && (checkpoint.sessionId !== session.conversationId || (!deadPendingRuntime && syncedCount === undefined)) &&
      this.matchesPersistedSession(checkpoint, input, serializedMessages)) {
      this.syncedMessages.set(session, serializedMessages.slice(0, checkpoint.messageCount));
      return { action: "resume", conversationId: checkpoint.sessionId };
    }

    debugLog("session", "Rebuilding runtime instead of reusing", {
      syncKeyMatches: session.syncKey === input.syncKey,
      messageCount: input.messages.length,
      syncedMessageCount: syncedCount,
      sessionConversationId: session.conversationId,
      inputConversationId: input.conversationId,
      processRunning: session.activeProcess?.isRunning ?? false,
      hasCheckpoint: checkpoint !== undefined,
      checkpointMatches: checkpoint ? this.matchesPersistedSession(checkpoint, input, serializedMessages) : false,
    });

    return { action: "rebuild" };
  }

  public getSyncedMessageCount(session: LiveSession): number | undefined {
    return this.syncedMessages.get(session)?.length;
  }

  public record(
    session: LiveSession,
    messages: readonly unknown[],
    assistantMessage?: unknown
  ): void {
    const serializedMessages = messages.map(serializeMessage);
    if (assistantMessage !== undefined) serializedMessages.push(serializeMessage(assistantMessage));
    this.syncedMessages.set(session, serializedMessages);
  }

  private matchesLiveSession(
    session: LiveSession,
    input: RuntimeSessionSyncInput,
    serializedMessages: readonly string[]
  ): boolean {
    if (!session.conversationId || !this.matchesConversationId(session.conversationId, input.conversationId)) return false;

    const previousMessages = this.syncedMessages.get(session);
    if (!previousMessages) return !this.hasUnsyncedAssistant(input.messages, 0);
    if (input.messages.length < previousMessages.length) {
      debugLog("session", "Live messages shortened", {
        expectedMessageCount: previousMessages.length,
        actualMessageCount: input.messages.length,
      });
      return false;
    }

    if (this.hasUnsyncedAssistant(input.messages, previousMessages.length)) return false;

    const mismatchIndex = previousMessages.findIndex((entry, index) =>
      entry !== serializedMessages[index]
    );
    if (mismatchIndex < 0) return true;

    if (isDebugEnabled()) {
      const expected: unknown = JSON.parse(previousMessages[mismatchIndex]!);
      const actual: unknown = JSON.parse(serializedMessages[mismatchIndex]!);
      const fields = changedFields(expected, actual);
      debugLog("session", "Live message mismatch", {
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
    checkpoint: AgyConversationCheckpoint,
    input: RuntimeSessionSyncInput,
    serializedMessages: readonly string[]
  ): boolean {
    if (checkpoint.hasPendingToolCalls === true) return false;
    if (input.compatibilityKey !== undefined && checkpoint.compatibilityKey !== input.compatibilityKey) return false;

    return (
      this.matchesConversationId(checkpoint.sessionId, input.conversationId) &&
      matchMessages(checkpoint, input.messages, serializedMessages) &&
      !this.hasUnsyncedAssistant(input.messages, checkpoint.messageCount!)
    );
  }

  private hasUnsyncedAssistant(messages: readonly unknown[], syncedCount: number): boolean {
    return messages.slice(syncedCount).some((message) => isRecord(message) && message.role === "assistant");
  }

  private matchesConversationId(
    expected: string | undefined,
    actual: string | undefined
  ): boolean {
    return expected === undefined || actual === undefined || expected === actual;
  }
}
