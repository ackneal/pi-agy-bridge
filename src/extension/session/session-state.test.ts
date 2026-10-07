import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { LiveSession, PiContextAdapter } from "./session.ts";
import { historyMatches, RuntimeSessionStore, RuntimeSessionSync } from "./session-state.ts";
import { CapabilityGateway } from "../bridge/capabilities.ts";
import type { AgyProcess } from "../runtime/process.ts";
import type { BridgeIPC } from "../bridge/bridge-ipc.ts";

describe("RuntimeSessionStore", () => {
  it("persists references, restores them after reopening, and preserves history metadata", async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), "agy-session-store-"));
    try {
      const manager = SessionManager.create("/workspace", sessionDir);
      const sessionId = manager.getSessionId();
      const piContext = new PiContextAdapter();
      piContext.bind(manager);
      const store = new RuntimeSessionStore(piContext);
      const history = [
        { role: "user", content: "question" },
        { role: "assistant", responseId: "agy-conversation", content: "answer" },
      ];
      const written = await store.set(sessionId, { conversationId: "agy-conversation" }, history);
      assert.equal(manager.buildSessionContext().messages.length, 0);

      manager.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
      manager.appendMessage({
        role: "assistant", content: [{ type: "text", text: "answer" }], api: "agy", provider: "agy",
        model: "test", responseId: "agy-conversation", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      });
      const sessionFile = manager.getSessionFile();
      assert.ok(sessionFile);
      const reopened = SessionManager.open(sessionFile);
      const reopenedContext = new PiContextAdapter();
      reopenedContext.bind(reopened);
      const restored = await new RuntimeSessionStore(reopenedContext).get(sessionId);

      assert.equal(restored?.conversationId, "agy-conversation");
      assert.equal(restored?.syncedEntryId, written.syncedEntryId);
      assert.equal(restored?.historyLength, history.length);
      assert.equal(restored?.historyHash, written.historyHash);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it("only returns the active branch reference and supports tombstone deletion", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const context = new PiContextAdapter();
    const sessionId = context.bind(manager);
    const store = new RuntimeSessionStore(context);
    manager.appendMessage({ role: "user", content: "branch point", timestamp: Date.now() });
    const branchPoint = manager.getLeafId();
    await store.set(sessionId, { conversationId: "agy-conversation" }, []);
    manager.branch(branchPoint!);
    assert.equal(await store.get(sessionId), undefined);

    await store.set(sessionId, { conversationId: "agy-conversation" }, []);
    await store.delete(sessionId);
    assert.equal(await store.get(sessionId), undefined);
  });

  it("rejects writes when the exact Pi session is not attached", async () => {
    const store = new RuntimeSessionStore(new PiContextAdapter());
    await assert.rejects(store.set("missing-session", { conversationId: "agy-conversation" }, []), /not attached to the bridge/);
    await assert.rejects(store.delete("missing-session"), /not attached to the bridge/);
  });
});

test("metadata changes preserve live pending tool results and versioned persisted history", async () => {
  const gateway = new CapabilityGateway([{ name: "read", description: "Read", parameters: { type: "object" } }]);
  let dispatch: ((call: unknown) => void) | undefined;
  const dispatched = new Promise<unknown>((resolve) => { dispatch = resolve; });
  gateway.setToolCallHandler((batch) => { dispatch!(batch.calls[0]); batch.complete(); });
  const result = gateway.call("read", { path: "package.json" });
  const call = await dispatched as { id: string };
  const user = { role: "user", content: "read package.json" };
  const assistant = { role: "assistant", content: [call], stopReason: "toolUse" };
  const replay = { ...assistant, thinkingLevel: "medium", timestamp: 123, usage: { input: 10 } };
  const toolResult = { role: "toolResult" as const, toolCallId: call.id, toolName: "read", content: [{ type: "text" as const, text: "pi-agy-bridge" }], isError: false, timestamp: 124 };
  const live = new LiveSession("metadata-test");
  live.setSession({ isRunning: true } as AgyProcess, "sync-key", undefined, "agy-conversation");
  const sync = new RuntimeSessionSync();
  sync.record(live, [user], assistant);
  assert.deepEqual(sync.decide(live, { syncKey: "sync-key", turnIndex: 0, canonicalHistory: [user, replay, toolResult] }), { action: "continue" });
  assert.equal(gateway.resolveToolResults([toolResult]), 1);
  assert.deepEqual(await result, { content: toolResult.content, isError: false });
  assert.equal(gateway.hasPendingCalls, false);

  const manager = SessionManager.inMemory("/workspace");
  const context = new PiContextAdapter();
  const sessionId = context.bind(manager);
  const ref = await new RuntimeSessionStore(context).set(sessionId, { conversationId: "agy-conversation" }, [user, assistant]);
  assert.equal(historyMatches(ref, [user, replay, toolResult]), true);
  const { historyFormat: _format, ...legacyRef } = ref;
  assert.equal(historyMatches(legacyRef, [user, replay]), false);
  assert.equal(historyMatches(ref, [user, { ...replay, content: [] }]), false);
});

describe("RuntimeSessionSync", () => {
  function createSession(isRunning: boolean): LiveSession {
    const session = new LiveSession("pi-session-a");
    session.setSession({ isRunning } as AgyProcess, "sync-key", undefined, "agy-conversation");
    return session;
  }

  const input = {
    syncKey: "sync-key", turnIndex: 0, conversationId: "agy-conversation",
    canonicalHistory: [{ role: "user", content: "question" }],
  };

  it("continues, resumes, or rebuilds according to process and synchronization state", () => {
    const sync = new RuntimeSessionSync();
    const live = createSession(true);
    assert.equal(sync.getSyncedMessageCount(live), undefined);
    sync.record(live, input.canonicalHistory, { role: "assistant", responseId: "agy-conversation", content: "answer" });
    assert.equal(sync.getSyncedMessageCount(live), 2);
    assert.deepEqual(sync.decide(live, { ...input, canonicalHistory: [...input.canonicalHistory, { role: "assistant", responseId: "agy-conversation", content: "answer" }, { role: "user", content: "next" }] }), { action: "continue" });

    const changedCases = [
      { ...input, canonicalHistory: [{ role: "user", content: "branch" }] },
      { ...input, syncKey: "other-model" }, { ...input, turnIndex: 1 }, { ...input, conversationId: "other-conversation" },
    ];
    for (const changed of changedCases) assert.deepEqual(sync.decide(live, changed), { action: "rebuild" });

    const dead = createSession(false);
    assert.deepEqual(sync.decide(dead, input), { action: "resume", conversationId: "agy-conversation" });
    assert.deepEqual(sync.decide(dead, { ...input, conversationId: "other" }), { action: "rebuild" });
  });

  it("reuses pending mixed continuations when history is compatible", async () => {
    const history = [
      { role: "user", content: "question" },
      { role: "assistant", content: "tool call", stopReason: "toolUse" },
    ];
    const toolResult = { role: "toolResult", content: "result", toolCallId: "call", toolName: "read" };
    const user = { role: "user", content: "next" };
    const system = { role: "system", content: "new instructions" };
    const manager = SessionManager.inMemory("/workspace");
    const context = new PiContextAdapter();
    const sessionId = context.bind(manager);
    const runtimeRef = await new RuntimeSessionStore(context).set(sessionId, { conversationId: "agy-conversation" }, history);
    const cases = [
      { name: "pending user", pending: true, appended: [toolResult, user], action: "continue" },
      { name: "pending system", pending: true, appended: [toolResult, system], action: "continue" },
      { name: "pending pure tool result", pending: true, appended: [toolResult], action: "continue" },
      { name: "no pending user", pending: false, appended: [toolResult, user], action: "continue" },
      { name: "persisted fallback pending mixed", pending: true, appended: [toolResult, user], action: "resume", fallback: true },
      { name: "unrecorded pending mixed", pending: true, appended: [toolResult, user], action: "continue", unrecorded: true },
      { name: "unrecorded pure tool result", pending: true, appended: [toolResult], action: "continue", unrecorded: true, toolOnly: true },
      { name: "rewritten prefix", pending: true, appended: [], action: "rebuild", rewritten: true },
      { name: "shortened prefix", pending: true, appended: [], action: "rebuild", shortened: true },
    ];

    for (const row of cases) {
      const sync = new RuntimeSessionSync();
      const live = createSession(true);
      live.activeMcpServer = { hasPendingCalls: row.pending } as BridgeIPC;
      if (!row.unrecorded) sync.record(live, history);
      const before = sync.getSyncedMessageCount(live);
      const canonicalHistory = row.shortened ? history.slice(0, 1)
        : row.rewritten ? [{ role: "user", content: "rewritten" }, history[1]!]
        : [...(row.toolOnly ? [] : history), ...row.appended];

      assert.deepEqual(sync.decide(live, {
        ...input,
        syncKey: row.fallback ? "other-key" : input.syncKey,
        canonicalHistory,
        ...(row.fallback ? { runtimeRef } : {}),
      }), row.fallback ? { action: row.action, conversationId: runtimeRef.conversationId } : { action: row.action }, row.name);
      assert.equal(sync.getSyncedMessageCount(live), row.fallback ? history.length : before, row.name);
    }
  });

  it("reuses a live process when Pi omits the conversation id for the latest turn", () => {
    const sync = new RuntimeSessionSync();
    const live = createSession(true);
    sync.record(live, input.canonicalHistory, { role: "assistant", content: "answer" });
    const { conversationId: _omitted, ...withoutConversationId } = input;

    assert.deepEqual(
      sync.decide(live, {
        ...withoutConversationId,
        canonicalHistory: [
          ...input.canonicalHistory,
          { role: "assistant", content: "answer" },
          { role: "user", content: "next" },
        ],
      }),
      { action: "continue" },
    );
  });

  it("resumes a persisted conversation when history matches and Pi omits its id", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const context = new PiContextAdapter();
    const sessionId = context.bind(manager);
    const history = [{ role: "user", content: "question" }];
    const store = new RuntimeSessionStore(context);
    await store.set(sessionId, { conversationId: "agy-conversation" }, history);
    const runtimeRef = await store.get(sessionId);
    assert.ok(runtimeRef);

    const sync = new RuntimeSessionSync();
    const resumed = new LiveSession(sessionId);
    assert.deepEqual(sync.decide(resumed, {
      syncKey: "sync-key",
      turnIndex: 1,
      canonicalHistory: [...history, { role: "user", content: "next" }],
      runtimeRef,
    }), { action: "resume", conversationId: "agy-conversation" });
    assert.equal(sync.getSyncedMessageCount(resumed), history.length);
  });
});
