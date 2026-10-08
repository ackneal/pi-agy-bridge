import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { LiveSession, PiContextAdapter } from "./session.ts";
import { historyMatches, RuntimeSessionStore, RuntimeSessionSync, type AgyRuntimeSessionRef } from "./session-state.ts";
import { HISTORY_FORMAT } from "./history.ts";
import { CapabilityGateway } from "../bridge/capabilities.ts";
import type { AgyProcess } from "../runtime/process.ts";
import type { BridgeIPC } from "../bridge/bridge-ipc.ts";

describe("RuntimeSessionStore", () => {
  const pendingMetadataCases = [
    { name: "omitted", metadata: {} },
    { name: "pending", metadata: { hasPendingCalls: true } },
    { name: "drained", metadata: { hasPendingCalls: false } },
  ];

  for (const { name, metadata } of pendingMetadataCases) {
    it(`roundtrips exact history and pending metadata after reopening: ${name}`, async () => {
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
        const written = await store.set(sessionId, { conversationId: "agy-conversation", ...metadata }, history);
        const expectedPending = typeof metadata.hasPendingCalls === "boolean" ? { hasPendingCalls: metadata.hasPendingCalls } : {};
        assert.deepEqual(written, {
          conversationId: "agy-conversation", syncedEntryId: written.syncedEntryId,
          historyHash: written.historyHash, historyLength: history.length, historyFormat: HISTORY_FORMAT,
          ...expectedPending,
        });
        const entry = manager.getBranch().at(-1);
        assert.ok(entry?.type === "custom");
        assert.deepEqual(entry.data, {
          conversationId: "agy-conversation", historyHash: written.historyHash,
          historyLength: history.length, historyFormat: HISTORY_FORMAT, ...expectedPending,
        });
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

        assert.deepEqual(restored, written);
      } finally {
        await rm(sessionDir, { recursive: true, force: true });
      }
    });
  }

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

test("metadata changes preserve live pending tool results and versioned persisted history", async (t) => {
  const gateway = new CapabilityGateway([{ name: "read", description: "Read", parameters: { type: "object" } }]);
  t.after(() => gateway.cancelPendingCalls("Test cleanup"));
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
  assert.deepEqual(sync.decide(live, { syncKey: "sync-key", canonicalHistory: [user, replay, toolResult] }), { action: "continue" });
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
    syncKey: "sync-key", conversationId: "agy-conversation",
    canonicalHistory: [{ role: "user", content: "question" }],
  };

  const pendingHistory = [
    { role: "user", content: "read files" },
    {
      role: "assistant", stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } },
        { type: "toolCall", id: "call-2", name: "read", arguments: { path: "b" } },
      ],
    },
  ];
  const results = [
    { role: "toolResult", toolCallId: "call-1", toolName: "read", content: "first", isError: false },
    { role: "toolResult", toolCallId: "call-2", toolName: "read", content: "second", isError: false },
  ];
  const drainedHistory = [...pendingHistory, ...results];
  const errorHistory = [
    pendingHistory[0]!,
    { role: "assistant", content: [], stopReason: "error", errorMessage: "Native request failed", provider: "agy" },
  ];

  const checkpointCases: {
    name: string;
    checkpoint: readonly unknown[];
    hasPendingCalls?: boolean;
    appended?: readonly unknown[];
    live?: boolean;
    keyChange?: boolean;
    action: "resume" | "rebuild" | "continue";
  }[] = [
    { name: "completed native error", checkpoint: errorHistory, action: "resume" },
    { name: "explicitly completed native error", checkpoint: errorHistory, hasPendingCalls: false, action: "resume" },
    { name: "pending toolUse checkpoint", checkpoint: pendingHistory, hasPendingCalls: true, action: "rebuild" },
    { name: "legacy toolUse checkpoint", checkpoint: pendingHistory, action: "rebuild" },
    { name: "legacy saved prefix still pending despite appended results", checkpoint: pendingHistory, appended: results, action: "rebuild" },
    { name: "explicit pending after some results", checkpoint: [...pendingHistory, results[0]!], hasPendingCalls: true, action: "rebuild" },
    { name: "explicit pending overrides drained-looking history", checkpoint: drainedHistory, hasPendingCalls: true, action: "rebuild" },
    { name: "legacy drained result checkpoint", checkpoint: drainedHistory, action: "resume" },
    { name: "explicitly drained result checkpoint", checkpoint: drainedHistory, hasPendingCalls: false, action: "resume" },
    { name: "explicitly accepted result prefix", checkpoint: [...pendingHistory, results[0]!], hasPendingCalls: false, action: "resume" },
    { name: "live broker with pending ref", checkpoint: pendingHistory, hasPendingCalls: true, appended: results, live: true, action: "continue" },
    { name: "live broker with pending ref and changed key", checkpoint: pendingHistory, hasPendingCalls: true, appended: results, live: true, keyChange: true, action: "continue" },
  ];

  for (const row of checkpointCases) {
    it(`selects a stored checkpoint safely: ${row.name}`, async () => {
      const manager = SessionManager.inMemory("/workspace");
      const context = new PiContextAdapter();
      const sessionId = context.bind(manager);
      const store = new RuntimeSessionStore(context);
      const ref: AgyRuntimeSessionRef = {
        conversationId: "agy-conversation",
        ...(row.hasPendingCalls !== undefined ? { hasPendingCalls: row.hasPendingCalls } : {}),
      };
      const written = await store.set(sessionId, ref, row.checkpoint);
      const runtimeRef = await store.get(sessionId);
      assert.deepEqual(runtimeRef, written);

      const sync = new RuntimeSessionSync();
      const session = row.live ? createSession(true) : new LiveSession(sessionId);
      if (row.live) {
        session.activeMcpServer = { hasPendingCalls: true } as BridgeIPC;
        sync.record(session, row.checkpoint);
      }
      const canonicalHistory = [...row.checkpoint, ...(row.appended ?? [])];
      assert.equal(historyMatches(runtimeRef!, canonicalHistory), true);

      const decision = sync.decide(session, {
        ...input, syncKey: row.keyChange ? "other-key" : input.syncKey, canonicalHistory, runtimeRef,
      });

      assert.deepEqual(decision, row.action === "resume"
        ? { action: "resume", conversationId: ref.conversationId }
        : { action: row.action });
      assert.equal(sync.getSyncedMessageCount(session), row.action === "rebuild" ? undefined : row.checkpoint.length);
    });
  }

  for (const metadata of [{}, { hasPendingCalls: true }, { hasPendingCalls: false }]) {
    it(`preserves semantic hashes with pending metadata ${JSON.stringify(metadata)}`, async () => {
      const manager = SessionManager.inMemory("/workspace");
      const context = new PiContextAdapter();
      const sessionId = context.bind(manager);
      const store = new RuntimeSessionStore(context);
      const replay = pendingHistory.map((message) => ({ ...message, timestamp: 123, usage: { input: 10 }, thinkingLevel: "high" }));

      const written = await store.set(sessionId, { conversationId: "agy-conversation", ...metadata }, replay);
      const restored = await store.get(sessionId);

      assert.equal(restored?.historyHash, "73ff574ccd10772c91f4a26307ecd687a77db8250e24c170c386f5236448ad00");
      assert.equal(written.historyHash, restored?.historyHash);
      assert.equal(historyMatches(restored!, pendingHistory), true);
      assert.equal(historyMatches(restored!, [...pendingHistory, ...results]), true);
      assert.equal(historyMatches(restored!, [pendingHistory[0]!, { ...pendingHistory[1]!, stopReason: "error" }]), false);
    });
  }

  const answer = { role: "assistant", responseId: "agy-conversation", content: "answer" };
  const recordedHistory = [...input.canonicalHistory, answer];
  for (const row of [
    { name: "live compatible continuation", running: true, recorded: true, current: { ...input, canonicalHistory: [...recordedHistory, { role: "user", content: "next" }] }, action: "continue" },
    { name: "live rewritten prefix", running: true, recorded: true, current: { ...input, canonicalHistory: [{ role: "user", content: "branch" }, answer] }, action: "rebuild" },
    { name: "live shortened prefix", running: true, recorded: true, current: input, action: "rebuild" },
    { name: "live changed key with compatible history", running: true, recorded: true, current: { ...input, syncKey: "other-model", canonicalHistory: recordedHistory }, action: "resume" },
    { name: "live changed conversation", running: true, recorded: true, current: { ...input, conversationId: "other-conversation", canonicalHistory: recordedHistory }, action: "rebuild" },
    { name: "dead compatible conversation", running: false, recorded: false, current: input, action: "resume" },
    { name: "dead different conversation", running: false, recorded: false, current: { ...input, conversationId: "other" }, action: "rebuild" },
  ]) {
    it(`selects by process and synchronization state: ${row.name}`, () => {
      const sync = new RuntimeSessionSync();
      const live = createSession(row.running);
      const process = live.activeProcess;
      assert.equal(sync.getSyncedMessageCount(live), undefined);
      if (row.recorded) sync.record(live, input.canonicalHistory, answer);
      const syncedCount = row.recorded ? recordedHistory.length : undefined;
      assert.equal(sync.getSyncedMessageCount(live), syncedCount);

      const decision = sync.decide(live, row.current);

      assert.deepEqual(decision, row.action === "resume"
        ? { action: "resume", conversationId: "agy-conversation" }
        : { action: row.action });
      assert.equal(sync.getSyncedMessageCount(live), syncedCount);
      assert.equal(live.activeProcess, process);
      assert.equal(live.conversationId, "agy-conversation");
      assert.equal(live.syncKey, input.syncKey);
    });
  }

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
      { name: "pending key change", pending: true, appended: [toolResult, user], action: "continue", keyChange: true },
      { name: "model key change without ref", pending: false, appended: [toolResult, user], action: "resume", keyChange: true },
      { name: "unrecorded pending mixed", pending: true, appended: [toolResult, user], action: "rebuild", unrecorded: true },
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
        syncKey: row.keyChange ? "other-key" : input.syncKey,
        canonicalHistory,
      }), row.action === "resume" ? { action: row.action, conversationId: runtimeRef.conversationId } : { action: row.action }, row.name);
      assert.equal(sync.getSyncedMessageCount(live), before, row.name);
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

  it("does not resume an older checkpoint over divergent live history or dead pending calls", async () => {
    const history = [input.canonicalHistory[0]!, { role: "assistant", content: "tool call", stopReason: "toolUse" }];
    const result = { role: "toolResult", toolCallId: "call", toolName: "read", content: "result" };
    const manager = SessionManager.inMemory("/workspace");
    const context = new PiContextAdapter();
    const id = context.bind(manager);
    const runtimeRef = await new RuntimeSessionStore(context).set(id, { conversationId: "agy-conversation" }, history);
    const cases = [
      { name: "shortened live history", isRunning: true, current: history },
      { name: "rewritten live result", isRunning: true, current: [...history, { ...result, content: "rewritten" }] },
      { name: "dead pending runtime", isRunning: false, current: [...history, result] },
    ];

    for (const row of cases) {
      const sync = new RuntimeSessionSync();
      const live = createSession(row.isRunning);
      live.activeMcpServer = { hasPendingCalls: true } as BridgeIPC;
      sync.record(live, [...history, result]);

      assert.deepEqual(sync.decide(live, {
        ...input, canonicalHistory: row.current, runtimeRef,
      }), { action: "rebuild" }, row.name);
    }
  });

  it("resumes a different branch using its own synchronized checkpoint", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const context = new PiContextAdapter();
    const id = context.bind(manager);
    const history = [input.canonicalHistory[0]!, { role: "assistant", content: "branch answer" }];
    const runtimeRef = await new RuntimeSessionStore(context).set(id, { conversationId: "branch-conversation" }, history);
    const cases = [
      { name: "shorter live conversation", running: true, pending: false },
      { name: "dead pending previous conversation", running: false, pending: true },
    ];

    for (const row of cases) {
      const sync = new RuntimeSessionSync();
      const live = createSession(row.running);
      live.activeMcpServer = { hasPendingCalls: row.pending } as BridgeIPC;
      sync.record(live, input.canonicalHistory);

      assert.deepEqual(sync.decide(live, {
        ...input, conversationId: "branch-conversation", runtimeRef,
        canonicalHistory: [...history, { role: "user", content: "next" }],
      }), { action: "resume", conversationId: "branch-conversation" }, row.name);
      assert.equal(sync.getSyncedMessageCount(live), history.length, row.name);
    }
  });

  it("separates conversation compatibility from runtime selection", async () => {
    const history = [input.canonicalHistory[0]!, { role: "assistant", content: "answer", provider: "agy" }];
    const manager = SessionManager.inMemory("/workspace");
    const context = new PiContextAdapter();
    const sessionId = context.bind(manager);
    const store = new RuntimeSessionStore(context);
    const runtimeRef = await store.set(sessionId, { conversationId: "agy-conversation" }, history);

    const cases = [
      { name: "model change no ref", key: "other", action: "resume" },
      { name: "pending model change", key: "other", pending: true, action: "continue" },
      { name: "foreign assistant without id", tail: [{ role: "assistant", content: "foreign" }], ref: runtimeRef, action: "rebuild" },
      { name: "agy unsynced assistant", tail: [{ role: "assistant", provider: "agy", responseId: "agy-conversation", content: "new" }], action: "rebuild" },
      { name: "persisted prefix", persisted: true, ref: runtimeRef, action: "resume" },
      { name: "persisted new assistant", persisted: true, ref: runtimeRef, tail: [{ role: "assistant", content: "new" }], action: "rebuild" },
      { name: "persisted wrong id", persisted: true, ref: runtimeRef, id: "other", action: "rebuild" },
      { name: "persisted old format", persisted: true, ref: { ...runtimeRef, historyFormat: "old" }, action: "rebuild" },
      { name: "persisted wrong hash", persisted: true, ref: { ...runtimeRef, historyHash: "wrong" }, action: "rebuild" },
      { name: "missing snapshot assistant", unrecorded: true, action: "rebuild" },
      { name: "missing snapshot user", unrecorded: true, userOnly: true, action: "continue" },
    ];

    for (const row of cases) {
      const sync = new RuntimeSessionSync();
      const live = row.persisted ? new LiveSession(sessionId) : createSession(true);
      live.activeMcpServer = { hasPendingCalls: row.pending ?? false } as BridgeIPC;
      if (!row.persisted && !row.unrecorded) sync.record(live, history);
      assert.deepEqual(sync.decide(live, {
        syncKey: row.key ?? input.syncKey,
        ...(row.id ? { conversationId: row.id } : {}),
        canonicalHistory: [...(row.userOnly ? input.canonicalHistory : history), ...(row.tail ?? [])],
        ...(row.ref ? { runtimeRef: row.ref } : {}),
      }), row.action === "resume" ? { action: "resume", conversationId: "agy-conversation" } : { action: row.action }, row.name);
      if (row.persisted && row.action === "resume") assert.equal(sync.getSyncedMessageCount(live), history.length);
    }
  });
});
