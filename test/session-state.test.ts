import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { LiveSession, PiContextAdapter } from "../src/session.ts";
import { RuntimeSessionStore, RuntimeSessionSync } from "../src/session-state.ts";
import type { AgyProcess } from "../src/process.ts";

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
    sync.record(live, input.canonicalHistory, { role: "assistant", responseId: "agy-conversation", content: "answer" });
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
    assert.deepEqual(sync.decide(new LiveSession(sessionId), {
      syncKey: "sync-key",
      turnIndex: 1,
      canonicalHistory: [...history, { role: "user", content: "next" }],
      runtimeRef,
    }), { action: "resume", conversationId: "agy-conversation" });
  });
});
