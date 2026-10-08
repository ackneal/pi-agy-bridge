import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { LiveSession, PiContextAdapter } from "./session.ts";
import { messagesMatch, RuntimeSessionStore, RuntimeSessionSync, type AgyConversationCheckpoint } from "./session-state.ts";
import { MESSAGE_FORMAT } from "./history.ts";
import { CapabilityGateway } from "../bridge/capabilities.ts";
import type { AgyProcess } from "../runtime/process.ts";
import type { BridgeIPC } from "../bridge/bridge-ipc.ts";

describe("RuntimeSessionStore", () => {
  const pendingMetadataCases = [
    { name: "omitted", metadata: {} },
    { name: "pending", metadata: { hasPendingToolCalls: true } },
    { name: "drained", metadata: { hasPendingToolCalls: false } },
  ];

  for (const { name, metadata } of pendingMetadataCases) {
    it(`roundtrips exact messages and pending metadata after reopening: ${name}`, async () => {
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
        const expectedPending = typeof metadata.hasPendingToolCalls === "boolean" ? { hasPendingToolCalls: metadata.hasPendingToolCalls } : {};
        assert.deepEqual(written, {
          conversationId: "agy-conversation",
          fingerprint: written.fingerprint, messageCount: history.length, messageFormat: MESSAGE_FORMAT,
          ...expectedPending,
        });
        const entry = manager.getBranch().at(-1);
        assert.ok(entry?.type === "custom");
        assert.deepEqual(entry.data, {
          conversationId: "agy-conversation", fingerprint: written.fingerprint,
          messageCount: history.length, messageFormat: MESSAGE_FORMAT, ...expectedPending,
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

  it("only returns the active branch checkpoint and supports tombstone deletion", async () => {
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

test("metadata changes preserve live pending tool results and versioned persisted messages", async (t) => {
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
  assert.deepEqual(sync.decide(live, { syncKey: "sync-key", messages: [user, replay, toolResult] }), { action: "continue" });
  assert.equal(gateway.resolveToolResults([toolResult]), 1);
  assert.deepEqual(await result, { content: toolResult.content, isError: false });
  assert.equal(gateway.hasPendingCalls, false);

  const manager = SessionManager.inMemory("/workspace");
  const context = new PiContextAdapter();
  const sessionId = context.bind(manager);
  const ref = await new RuntimeSessionStore(context).set(sessionId, { conversationId: "agy-conversation" }, [user, assistant]);
  assert.equal(messagesMatch(ref, [user, replay, toolResult]), true);
  assert.equal(messagesMatch(ref, [user, { ...replay, content: [] }]), false);
});

describe("RuntimeSessionSync", () => {
  function createSession(isRunning: boolean): LiveSession {
    const session = new LiveSession("pi-session-a");
    session.setSession({ isRunning } as AgyProcess, "sync-key", undefined, "agy-conversation");
    return session;
  }

  const input = {
    syncKey: "sync-key", conversationId: "agy-conversation",
    messages: [{ role: "user", content: "question" }],
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
    messages: readonly unknown[];
    hasPendingToolCalls?: boolean;
    appended?: readonly unknown[];
    live?: boolean;
    keyChange?: boolean;
    action: "resume" | "rebuild" | "continue";
  }[] = [
    { name: "completed native error", messages: errorHistory, action: "resume" },
    { name: "explicitly completed native error", messages: errorHistory, hasPendingToolCalls: false, action: "resume" },
    { name: "pending toolUse checkpoint", messages: pendingHistory, hasPendingToolCalls: true, action: "rebuild" },
    { name: "explicit pending after some results", messages: [...pendingHistory, results[0]!], hasPendingToolCalls: true, action: "rebuild" },
    { name: "explicit pending overrides drained-looking history", messages: drainedHistory, hasPendingToolCalls: true, action: "rebuild" },
    { name: "drained checkpoint with omitted pending flag", messages: drainedHistory, action: "resume" },
    { name: "explicitly drained result checkpoint", messages: drainedHistory, hasPendingToolCalls: false, action: "resume" },
    { name: "explicitly accepted result prefix", messages: [...pendingHistory, results[0]!], hasPendingToolCalls: false, action: "resume" },
    { name: "live broker with pending checkpoint", messages: pendingHistory, hasPendingToolCalls: true, appended: results, live: true, action: "continue" },
    { name: "live broker with pending checkpoint and changed key", messages: pendingHistory, hasPendingToolCalls: true, appended: results, live: true, keyChange: true, action: "continue" },
  ];

  for (const row of checkpointCases) {
    it(`selects a stored checkpoint safely: ${row.name}`, async () => {
      const manager = SessionManager.inMemory("/workspace");
      const context = new PiContextAdapter();
      const sessionId = context.bind(manager);
      const store = new RuntimeSessionStore(context);
      const ref: AgyConversationCheckpoint = {
        conversationId: "agy-conversation",
        ...(row.hasPendingToolCalls !== undefined ? { hasPendingToolCalls: row.hasPendingToolCalls } : {}),
      };
      const written = await store.set(sessionId, ref, row.messages);
      const checkpoint = await store.get(sessionId);
      assert.deepEqual(checkpoint, written);

      const sync = new RuntimeSessionSync();
      const session = row.live ? createSession(true) : new LiveSession(sessionId);
      if (row.live) {
        session.activeMcpServer = { hasPendingCalls: true } as BridgeIPC;
        sync.record(session, row.messages);
      }
      const messages = [...row.messages, ...(row.appended ?? [])];
      assert.equal(messagesMatch(checkpoint!, messages), true);

      const decision = sync.decide(session, {
        ...input, syncKey: row.keyChange ? "other-key" : input.syncKey, messages, checkpoint,
      });

      assert.deepEqual(decision, row.action === "resume"
        ? { action: "resume", conversationId: ref.conversationId }
        : { action: row.action });
      assert.equal(sync.getSyncedMessageCount(session), row.action === "rebuild" ? undefined : row.messages.length);
    });
  }

  for (const metadata of [{}, { hasPendingToolCalls: true }, { hasPendingToolCalls: false }]) {
    it(`preserves semantic fingerprints with pending metadata ${JSON.stringify(metadata)}`, async () => {
      const manager = SessionManager.inMemory("/workspace");
      const context = new PiContextAdapter();
      const sessionId = context.bind(manager);
      const store = new RuntimeSessionStore(context);
      const replay = pendingHistory.map((message) => ({ ...message, timestamp: 123, usage: { input: 10 }, thinkingLevel: "high" }));

      const written = await store.set(sessionId, { conversationId: "agy-conversation", ...metadata }, replay);
      const restored = await store.get(sessionId);

      assert.equal(restored?.fingerprint, "73ff574ccd10772c91f4a26307ecd687a77db8250e24c170c386f5236448ad00");
      assert.equal(written.fingerprint, restored?.fingerprint);
      assert.equal(messagesMatch(restored!, pendingHistory), true);
      assert.equal(messagesMatch(restored!, [...pendingHistory, ...results]), true);
      assert.equal(messagesMatch(restored!, [pendingHistory[0]!, { ...pendingHistory[1]!, stopReason: "error" }]), false);
    });
  }

  const answer = { role: "assistant", responseId: "agy-conversation", content: "answer" };
  const recordedHistory = [...input.messages, answer];
  for (const row of [
    { name: "live compatible continuation", running: true, recorded: true, current: { ...input, messages: [...recordedHistory, { role: "user", content: "next" }] }, action: "continue" },
    { name: "live rewritten prefix", running: true, recorded: true, current: { ...input, messages: [{ role: "user", content: "branch" }, answer] }, action: "rebuild" },
    { name: "live shortened prefix", running: true, recorded: true, current: input, action: "rebuild" },
    { name: "live changed key with compatible history", running: true, recorded: true, current: { ...input, syncKey: "other-model", messages: recordedHistory }, action: "resume" },
    { name: "live changed conversation", running: true, recorded: true, current: { ...input, conversationId: "other-conversation", messages: recordedHistory }, action: "rebuild" },
    { name: "dead compatible conversation", running: false, recorded: false, current: input, action: "resume" },
    { name: "dead different conversation", running: false, recorded: false, current: { ...input, conversationId: "other" }, action: "rebuild" },
  ]) {
    it(`selects by process and synchronization state: ${row.name}`, () => {
      const sync = new RuntimeSessionSync();
      const live = createSession(row.running);
      const process = live.activeProcess;
      assert.equal(sync.getSyncedMessageCount(live), undefined);
      if (row.recorded) sync.record(live, input.messages, answer);
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
    const checkpoint = await new RuntimeSessionStore(context).set(sessionId, { conversationId: "agy-conversation" }, history);
    const cases = [
      { name: "pending user", pending: true, appended: [toolResult, user], action: "continue" },
      { name: "pending system", pending: true, appended: [toolResult, system], action: "continue" },
      { name: "pending pure tool result", pending: true, appended: [toolResult], action: "continue" },
      { name: "no pending user", pending: false, appended: [toolResult, user], action: "continue" },
      { name: "pending key change", pending: true, appended: [toolResult, user], action: "continue", keyChange: true },
      { name: "model key change without checkpoint", pending: false, appended: [toolResult, user], action: "resume", keyChange: true },
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
      const messages = row.shortened ? history.slice(0, 1)
        : row.rewritten ? [{ role: "user", content: "rewritten" }, history[1]!]
        : [...(row.toolOnly ? [] : history), ...row.appended];

      assert.deepEqual(sync.decide(live, {
        ...input,
        syncKey: row.keyChange ? "other-key" : input.syncKey,
        messages,
      }), row.action === "resume" ? { action: row.action, conversationId: checkpoint.conversationId } : { action: row.action }, row.name);
      assert.equal(sync.getSyncedMessageCount(live), before, row.name);
    }
  });

  it("reuses a live process when Pi omits the conversation id for the latest turn", () => {
    const sync = new RuntimeSessionSync();
    const live = createSession(true);
    sync.record(live, input.messages, { role: "assistant", content: "answer" });
    const { conversationId: _omitted, ...withoutConversationId } = input;

    assert.deepEqual(
      sync.decide(live, {
        ...withoutConversationId,
        messages: [
          ...input.messages,
          { role: "assistant", content: "answer" },
          { role: "user", content: "next" },
        ],
      }),
      { action: "continue" },
    );
  });

  it("does not resume an older checkpoint over divergent live history or dead pending calls", async () => {
    const history = [input.messages[0]!, { role: "assistant", content: "tool call", stopReason: "toolUse" }];
    const result = { role: "toolResult", toolCallId: "call", toolName: "read", content: "result" };
    const manager = SessionManager.inMemory("/workspace");
    const context = new PiContextAdapter();
    const id = context.bind(manager);
    const checkpoint = await new RuntimeSessionStore(context).set(id, { conversationId: "agy-conversation" }, history);
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
        ...input, messages: row.current, checkpoint,
      }), { action: "rebuild" }, row.name);
    }
  });

  it("resumes a different branch using its own synchronized checkpoint", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const context = new PiContextAdapter();
    const id = context.bind(manager);
    const history = [input.messages[0]!, { role: "assistant", content: "branch answer" }];
    const checkpoint = await new RuntimeSessionStore(context).set(id, { conversationId: "branch-conversation" }, history);
    const cases = [
      { name: "shorter live conversation", running: true, pending: false },
      { name: "dead pending previous conversation", running: false, pending: true },
    ];

    for (const row of cases) {
      const sync = new RuntimeSessionSync();
      const live = createSession(row.running);
      live.activeMcpServer = { hasPendingCalls: row.pending } as BridgeIPC;
      sync.record(live, input.messages);

      assert.deepEqual(sync.decide(live, {
        ...input, conversationId: "branch-conversation", checkpoint,
        messages: [...history, { role: "user", content: "next" }],
      }), { action: "resume", conversationId: "branch-conversation" }, row.name);
      assert.equal(sync.getSyncedMessageCount(live), history.length, row.name);
    }
  });

  it("separates conversation compatibility from runtime selection", async () => {
    const history = [input.messages[0]!, { role: "assistant", content: "answer", provider: "agy" }];
    const manager = SessionManager.inMemory("/workspace");
    const context = new PiContextAdapter();
    const sessionId = context.bind(manager);
    const store = new RuntimeSessionStore(context);
    const checkpoint = await store.set(sessionId, { conversationId: "agy-conversation" }, history);

    const cases = [
      { name: "model change without checkpoint", key: "other", action: "resume" },
      { name: "pending model change", key: "other", pending: true, action: "continue" },
      { name: "foreign assistant without id", tail: [{ role: "assistant", content: "foreign" }], ref: checkpoint, action: "rebuild" },
      { name: "agy unsynced assistant", tail: [{ role: "assistant", provider: "agy", responseId: "agy-conversation", content: "new" }], action: "rebuild" },
      { name: "persisted prefix", persisted: true, ref: checkpoint, action: "resume" },
      { name: "persisted new assistant", persisted: true, ref: checkpoint, tail: [{ role: "assistant", content: "new" }], action: "rebuild" },
      { name: "persisted wrong id", persisted: true, ref: checkpoint, id: "other", action: "rebuild" },
      { name: "persisted unsupported message format", persisted: true, ref: { ...checkpoint, messageFormat: "unsupported" }, action: "rebuild" },
      { name: "persisted fingerprint mismatch", persisted: true, ref: { ...checkpoint, fingerprint: "wrong" }, action: "rebuild" },
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
        messages: [...(row.userOnly ? input.messages : history), ...(row.tail ?? [])],
        ...(row.ref ? { checkpoint: row.ref } : {}),
      }), row.action === "resume" ? { action: "resume", conversationId: "agy-conversation" } : { action: row.action }, row.name);
      if (row.persisted && row.action === "resume") assert.equal(sync.getSyncedMessageCount(live), history.length);
    }
  });
});
