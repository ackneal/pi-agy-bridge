import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BridgeIPC } from "../bridge/bridge-ipc.ts";
import { CapabilityGateway } from "../bridge/capabilities.ts";
import { AgyRuntime } from "../runtime/process.ts";
import { calculateSyncKey } from "../session/session.ts";
import type { RuntimeSessionDecision } from "../session/session-state.ts";
import type { AgyInput, AgyResultEvent } from "../shared/types.ts";
import { AgyBridge, streamAgyProvider } from "./provider.ts";

const cases: { decision: RuntimeSessionDecision; incremental?: boolean; payload?: "replace" | "unchanged" | "reject" }[] = [
  { decision: { action: "continue" } },
  { decision: { action: "resume", conversationId: "old-conversation" } },
  { decision: { action: "rebuild" } },
  { decision: { action: "continue" }, incremental: true },
  { decision: { action: "continue" }, payload: "replace" },
  { decision: { action: "continue" }, payload: "unchanged" },
  { decision: { action: "continue" }, payload: "reject" },
];

for (const { decision, incremental, payload } of cases) {
  test(`streamAgyProvider completes a ${decision.action} turn${incremental ? " with all incremental messages" : ""}${payload ? ` with async payload ${payload}` : ""}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-runtime-turn-"));
    const pi = {
      on: () => {}, registerProvider: () => {}, registerCommand: () => {},
      getActiveTools: () => [], getAllTools: () => [],
    } as unknown as ExtensionAPI;
    const agyPath = path.join(directory, "agy");
    const config = { agyPath, pluginDir: path.join(directory, "plugin"), models: [] };
    const bridge = new AgyBridge(pi, config);
    t.after(async () => {
      try {
        await bridge.liveSessions.disposeAll();
      } finally {
        t.mock.restoreAll();
        await rm(directory, { recursive: true, force: true });
      }
    });
    await writeFile(agyPath, '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo 1.2.14\nelse\n  exit 1\nfi\n', { mode: 0o755 });

    const environment = { PI_AGY_BRIDGE_MCP_COMMAND: "mock-mcp" };
    const startBridge = t.mock.method(BridgeIPC.prototype, "start", async () => {});
    const close = t.mock.method(BridgeIPC.prototype, "close", async () => {});
    const dispatch = t.mock.method(BridgeIPC.prototype, "setToolCallHandler");
    const getEnvironment = t.mock.getter(BridgeIPC.prototype, "processEnvironment", () => environment);
    const install = t.mock.method(AgyBridge.prototype, "ensureAgyPluginInstalled", async () => {});
    t.mock.getter(AgyRuntime.prototype, "isRunning", () => true);
    const startProc = t.mock.method(AgyRuntime.prototype, "start", async () => ({
      event: "init", conversation_id: decision.action === "resume" ? "old-conversation" : "new-conversation",
    }) as Awaited<ReturnType<AgyRuntime["start"]>>);
    const abort = t.mock.method(AgyRuntime.prototype, "abort", async () => {});
    const listeners = new Map<AgyRuntime, Parameters<AgyRuntime["onEvent"]>[0]>();
    const unsubscribe = t.mock.fn(() => {});
    t.mock.method(AgyRuntime.prototype, "onEvent", function (this: AgyRuntime, listener: Parameters<AgyRuntime["onEvent"]>[0]) {
      listeners.set(this, listener);
      return () => {
        listeners.delete(this);
        unsubscribe();
      };
    });
    const send = t.mock.method(AgyRuntime.prototype, "send", async function (this: AgyRuntime, _input: AgyInput) {
      const listener = listeners.get(this);
      assert.ok(listener, "provider must subscribe before sending");
      assert.equal(typeof dispatch.mock.calls.at(-1)?.arguments[0], "function", "tool dispatch must be ready before sending");
      listener({ event: "step_update", delta: "success answer" }, "agy");
      listener({ event: "result", status: "success" }, "agy");
    });
    const decide = t.mock.method(bridge.runtimeSessionSync, "decide", () => decision);
    t.mock.method(bridge.runtimeSessionStore, "get", async () => undefined);
    const persist = t.mock.method(bridge.runtimeSessionStore, "set", async () => {});

    bridge.start();
    const liveSession = bridge.liveSessions.getOrCreate("test-turn");
    liveSession.conversationId = "old-conversation";
    let existingProcess: AgyRuntime | undefined;
    if (decision.action === "continue") {
      existingProcess = new AgyRuntime({ agentName: "pi-bridge", model: "test-model" });
      const existingMcp = new BridgeIPC([], liveSession.id, liveSession.resources);
      liveSession.setSession(existingProcess, "old-sync-key", existingMcp, "old-conversation");
    }
    const context: Context = {
      systemPrompt: "Rules & constraints",
      messages: [
        { role: "user", content: "earlier <question>", timestamp: 1 },
        { role: "user", content: "latest & request", timestamp: 2 },
      ],
      tools: [],
    };
    if (incremental) {
      bridge.runtimeSessionSync.record(liveSession, context.messages.slice(0, 1));
      context.messages.splice(1, 0, { role: "system", content: "new system instruction", timestamp: 2 });
    }
    const model = {
      id: "test-model", name: "Test model", api: "agy", provider: "agy",
      baseUrl: "agy", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192, maxTokens: 1024,
    } as Model<any>;
    const events: AssistantMessageEvent[] = [];
    const onPayload = t.mock.fn(async (_value: unknown, _selectedModel: Model<any>) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (payload === "reject") throw new Error("payload callback failed");
      return payload === "replace" ? { prompt: "replacement prompt" } : undefined;
    });
    const options = {
      sessionId: "test-turn",
      ...(payload ? { onPayload } : {}),
    };
    for await (const event of streamAgyProvider(model, context, options, config, bridge)) {
      events.push(event);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(onPayload.mock.callCount(), payload ? 1 : 0);
    if (payload) {
      assert.deepEqual(onPayload.mock.calls[0]!.arguments, [{ prompt: "latest & request" }, model]);
    }
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(events.some((event) => event.type === "error"), false);
    const terminal = events.at(-1);
    if (terminal?.type === "done") {
      assert.equal(terminal.reason, "stop");
      assert.deepEqual(terminal.message.content, [{ type: "text", text: "success answer" }]);
    }
    assert.equal(decide.mock.callCount(), 1);
    assert.equal(send.mock.callCount(), 1);
    assert.equal(unsubscribe.mock.callCount(), 1);
    assert.equal(listeners.size, 0);
    const completed = events.at(-1);
    assert.ok(completed?.type === "done");
    assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(liveSession), context.messages.length + 1);
    assert.equal(persist.mock.callCount(), 1);
    assert.deepEqual(persist.mock.calls[0]!.arguments[2], [...context.messages, completed.message]);
    const starts = decision.action === "continue" ? 0 : 1;
    assert.equal(startProc.mock.callCount(), starts);
    assert.equal(startBridge.mock.callCount(), starts);
    assert.equal(install.mock.callCount(), starts);
    assert.equal(getEnvironment.mock.callCount(), starts);
    assert.equal(close.mock.callCount(), 0);
    assert.equal(abort.mock.callCount(), 0);
    if (decision.action === "continue") {
      assert.equal(liveSession.activeProcess, existingProcess);
    } else {
      assert.deepEqual(liveSession.activeProcess?.options.environment, environment);
      assert.equal(liveSession.activeProcess?.options.conversationId,
        decision.action === "resume" ? "old-conversation" : undefined);
    }
    const prompt = send.mock.calls[0]!.arguments[0].message.content;
    if (payload === "replace") {
      assert.equal(prompt, "replacement prompt");
    } else if (incremental) {
      assert.deepEqual(JSON.parse(prompt), {
        purpose: "incremental_conversation",
        messages: [
          { role: "system", content: "new system instruction" },
          { role: "user", content: "latest & request" },
        ],
      });
    } else if (decision.action !== "rebuild") {
      assert.equal(prompt, "latest & request");
    } else {
      assert.equal(prompt, '{"purpose":"reconstructed_conversation","systemInstructions":"Rules & constraints","history":[{"role":"user","content":"earlier <question>"}],"currentMessage":{"role":"user","content":"latest & request"}}');
    }
    await bridge.liveSessions.disposeAll();
    assert.equal(close.mock.callCount(), 1);
    assert.equal(abort.mock.callCount(), 1);
  });
}

const invalidBatchCases = [
  {
    name: "unknown result after a valid result",
    results: (ids: string[]) => [ids[0]!, "unknown-call"],
    error: (_ids: string[]) => "Unknown tool result ID: unknown-call",
  },
  {
    name: "missing result from a dispatched batch",
    results: (ids: string[]) => [ids[0]!],
    error: (ids: string[]) => `Missing tool result ID: ${ids[1]}`,
  },
  {
    name: "duplicate result in a malformed batch",
    results: (ids: string[]) => [ids[0]!, ids[0]!],
    error: (ids: string[]) => `Duplicate tool result ID: ${ids[0]}`,
  },
];

for (const row of invalidBatchCases) {
  test(`streamAgyProvider invalidates ${row.name} through real gateway validation`, { timeout: 5000 }, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-invalid-batch-"));
    const pi = {
      on: () => {}, registerProvider: () => {}, registerCommand: () => {},
      getActiveTools: () => [], getAllTools: () => [],
    } as unknown as ExtensionAPI;
    const config = { agyPath: path.join(directory, "agy"), pluginDir: directory, models: [] };
    const bridge = new AgyBridge(pi, config);
    t.after(async () => {
      try {
        await bridge.liveSessions.disposeAll();
      } finally {
        t.mock.restoreAll();
        await rm(directory, { recursive: true, force: true });
      }
    });
    await writeFile(config.agyPath, '#!/bin/sh\necho 1.2.14\n', { mode: 0o755 });
    const close = t.mock.method(BridgeIPC.prototype, "close", async () => {});
    const abort = t.mock.method(AgyRuntime.prototype, "abort", async () => {});
    const send = t.mock.method(AgyRuntime.prototype, "send", async () => {});
    let listener: Parameters<AgyRuntime["onEvent"]>[0] | undefined;
    t.mock.method(AgyRuntime.prototype, "onEvent", (callback: Parameters<AgyRuntime["onEvent"]>[0]) => {
      listener = callback;
      return () => { listener = undefined; };
    });
    t.mock.method(bridge.runtimeSessionSync, "decide", () => ({ action: "continue" }) as RuntimeSessionDecision);
    bridge.start();
    const sessionId = bridge.piContextAdapter.bind(SessionManager.inMemory(directory));
    const session = bridge.liveSessions.getOrCreate(sessionId);
    const proc = new AgyRuntime({ agentName: "pi-bridge", model: "test-model" });
    session.setSession(proc, "old-sync-key", new BridgeIPC([], session.id, session.resources), "old-conversation");
    const gateway = new CapabilityGateway([
      { name: "test-tool", description: "test", parameters: { type: "object", properties: {} } },
    ], session.resources);
    t.after(() => gateway.cancelPendingCalls("test cleanup"));
    const ids: string[] = [];
    gateway.setToolCallHandler((batch) => {
      ids.push(...batch.calls.map((call) => call.id));
      batch.complete();
    });
    let delivered = 0;
    const pendingResults = [gateway.call("test-tool", {}), gateway.call("test-tool", {})]
      .map((result) => result.then((value) => { delivered++; return value; }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ids.length, 2);
    t.mock.getter(BridgeIPC.prototype, "hasPendingCalls", () => gateway.hasPendingCalls);
    const resolve = t.mock.method(BridgeIPC.prototype, "resolveToolResults", (messages: Context["messages"], appendix?: string) => {
      assert.ok(listener, "subscribe before validating the batch");
      return gateway.resolveToolResults(messages, appendix);
    });
    const context: Context = {
      tools: [], messages: row.results(ids).map((toolCallId) => ({
        role: "toolResult", toolCallId, toolName: "test-tool",
        content: [{ type: "text", text: "tool answer" }], isError: false, timestamp: 2,
      })),
    };
    bridge.runtimeSessionSync.record(session, []);
    await bridge.runtimeSessionStore.set(sessionId, { conversationId: "old-conversation", hasPendingToolCalls: true }, []);
    const record = t.mock.method(bridge.runtimeSessionSync, "record", bridge.runtimeSessionSync.record.bind(bridge.runtimeSessionSync));
    const persist = t.mock.method(bridge.runtimeSessionStore, "set", bridge.runtimeSessionStore.set.bind(bridge.runtimeSessionStore));
    const invalidate = t.mock.method(bridge.runtimeSessionStore, "delete", bridge.runtimeSessionStore.delete.bind(bridge.runtimeSessionStore));
    const model = {
      id: "test-model", name: "Test", api: "agy", provider: "agy", baseUrl: "agy",
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192, maxTokens: 1024,
    } as Model<any>;

    const events: AssistantMessageEvent[] = [];
    for await (const event of streamAgyProvider(model, context, { sessionId }, config, bridge)) events.push(event);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const terminal = events.at(-1);
    assert.ok(terminal?.type === "error");
    assert.equal(terminal.reason, "error");
    assert.equal(terminal.error.errorMessage, row.error(ids));
    assert.equal(resolve.mock.callCount(), 1);
    assert.deepEqual(resolve.mock.calls[0]!.arguments, [context.messages, undefined]);
    assert.equal(delivered, 0, "validation must reject the entire batch before delivering even its valid result");
    assert.equal(gateway.hasPendingCalls, true);
    assert.equal(send.mock.callCount(), 0);
    assert.equal(record.mock.callCount(), 0);
    assert.equal(persist.mock.callCount(), 0);
    assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), 0);
    assert.equal(invalidate.mock.callCount(), 1);
    assert.deepEqual(invalidate.mock.calls[0]!.arguments, [sessionId]);
    assert.equal(await bridge.runtimeSessionStore.get(sessionId), undefined);
    assert.equal(session.activeProcess, null);
    assert.equal(session.activeMcpServer, null);
    assert.equal(listener, undefined);
    assert.equal(close.mock.callCount(), 1);
    assert.equal(abort.mock.callCount(), 1);

    gateway.cancelPendingCalls("test cleanup");
    assert.ok((await Promise.all(pendingResults)).every((result) => result.isError));
    await bridge.liveSessions.disposeAll();
    assert.equal(close.mock.callCount(), 1);
    assert.equal(abort.mock.callCount(), 1);
  });
}

const continueCases = [
  { scenario: "pending tool results", pending: true, toolResults: true, reason: "stop", sends: 0, persists: 2, synced: 2 },
  { scenario: "mixed pending messages", pending: true, toolResults: true, reason: "stop", sends: 0, persists: 2, synced: 3 },
  { scenario: "queued calls without results", pending: true, toolResults: false, reason: "error", sends: 0, persists: 0, synced: 0, error: "Antigravity CLI is waiting for Pi tool results, but no matching result was returned" },
  { scenario: "resolver exception", pending: true, toolResults: true, reason: "error", sends: 0, persists: 0, synced: 0, error: "result resolver failed" },
  { scenario: "MCP write failure followed by quota", pending: true, toolResults: true, reason: "error", sends: 0, persists: 1, synced: 1, error: "MCP write failed" },
  { scenario: "transport failure", pending: true, toolResults: true, reason: "error", sends: 0, persists: 1, synced: 1, error: "MCP write failed" },
  { scenario: "model error after enqueued results with tools pending", pending: true, toolResults: true, reason: "error", sends: 0, persists: 1, synced: 1, error: "model error with pending tools" },
  { scenario: "runtime error after enqueued results with tools pending", pending: true, toolResults: true, reason: "error", sends: 0, persists: 1, synced: 1, error: "synthetic process failure" },
  { scenario: "error while tools pending", pending: true, toolResults: false, reason: "error", sends: 0, persists: 0, synced: 0, error: "model error with pending tools" },
  { scenario: "blocked native tool", pending: false, toolResults: false, reason: "error", sends: 1, persists: 0, synced: 0, error: "The model attempted to call an unavailable tool: run_command" },
  { scenario: "runtime synthetic failure", pending: false, toolResults: false, reason: "error", sends: 1, persists: 0, synced: 0, error: "synthetic process failure" },
  { scenario: "abort", pending: false, toolResults: false, reason: "aborted", sends: 1, persists: 0, synced: 0 },
  { scenario: "payload abort", pending: false, toolResults: false, reason: "aborted", sends: 0, persists: 0, synced: 0 },
] as const;

for (const row of continueCases) {
  const { scenario } = row;
  test(`streamAgyProvider mocked continue handles ${scenario}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-runtime-continue-"));
    const pi = {
      on: () => {}, registerProvider: () => {}, registerCommand: () => {},
      getActiveTools: () => [], getAllTools: () => [],
    } as unknown as ExtensionAPI;
    const config = { agyPath: path.join(directory, "agy"), pluginDir: path.join(directory, "plugin"), models: [] };
    const bridge = new AgyBridge(pi, config);
    t.after(async () => {
      try {
        await bridge.liveSessions.disposeAll();
      } finally {
        t.mock.restoreAll();
        await rm(directory, { recursive: true, force: true });
      }
    });
    await writeFile(config.agyPath, '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo 1.2.14\nelse\n  exit 1\nfi\n', { mode: 0o755 });
    const controller = new AbortController();
    const close = t.mock.method(BridgeIPC.prototype, "close", async () => {});
    const abort = t.mock.method(AgyRuntime.prototype, "abort", async () => {});
    let listener: Parameters<AgyRuntime["onEvent"]>[0] | undefined;
    const unsubscribe = t.mock.fn(() => { listener = undefined; });
    t.mock.method(AgyRuntime.prototype, "onEvent", (callback: Parameters<AgyRuntime["onEvent"]>[0]) => {
      listener = callback;
      return unsubscribe;
    });
    const send = t.mock.method(AgyRuntime.prototype, "send", async () => {
      assert.ok(listener, "provider must subscribe before sending");
      const captured = listener;
      if (scenario === "blocked native tool") {
        captured({ event: "step_update", tool_call: { id: "native-call", name: "run_command", arguments: {} } }, "agy");
        captured({ event: "result", status: "error", error: "Individual quota reached" }, "agy");
      } else if (scenario === "runtime synthetic failure") {
        listener({ event: "result", status: "error", error: "synthetic process failure" }, "runtime");
      } else {
        controller.abort();
      }
    });
    let pending = row.pending;
    t.mock.getter(BridgeIPC.prototype, "hasPendingCalls", () => pending);
    const resolve = t.mock.method(BridgeIPC.prototype, "resolveToolResults", (_results: Context["messages"], _appendix?: string) => {
      assert.ok(listener, "provider must subscribe before resolving tool results");
      if (scenario === "resolver exception") throw new Error("result resolver failed");
      if (scenario === "error while tools pending") {
        listener({ event: "result", result: { status: "error", error: "model error with pending tools" } }, "agy");
        return 0;
      }
      if (scenario === "queued calls without results") return 0;
      const captured = listener;
      setImmediate(() => {
        if (["transport failure", "MCP write failure followed by quota"].includes(scenario)) {
          (mcp as unknown as { failTransport(error: Error): void }).failTransport(new Error("MCP write failed"));
          if (scenario === "MCP write failure followed by quota") captured({ event: "result", status: "error", error: "Individual quota reached" }, "agy");
        } else if (scenario === "model error after enqueued results with tools pending") {
          captured({ event: "result", status: "error", error: "model error with pending tools" }, "agy");
        } else if (scenario === "runtime error after enqueued results with tools pending") {
          captured({ event: "result", status: "error", error: "synthetic process failure" }, "runtime");
        } else {
          pending = false;
          captured({ event: "result", status: "success" }, "agy");
        }
      });
      return _results.length;
    });
    t.mock.method(bridge.runtimeSessionSync, "decide", () => ({ action: "continue" }) as RuntimeSessionDecision);
    const restore = t.mock.method(bridge.runtimeSessionStore, "get", async () => undefined);
    const persist = t.mock.method(bridge.runtimeSessionStore, "set", async () => {});
    const invalidate = t.mock.method(bridge.runtimeSessionStore, "delete", async () => {});
    bridge.start();
    const session = bridge.liveSessions.getOrCreate("continue-regression");
    const proc = new AgyRuntime({ agentName: "pi-bridge", model: "test-model" });
    const mcp = new BridgeIPC([], session.id, session.resources);
    session.setSession(proc, "old-sync-key", mcp, "old-conversation");
    const context: Context = {
      messages: row.toolResults
        ? [{ role: "toolResult", toolCallId: "pending-call", toolName: "test-tool", content: [{ type: "text", text: "tool answer" }], isError: false, timestamp: 2 }]
        : [{ role: "user", content: "latest request", timestamp: 2 }],
      tools: [],
    };
    bridge.runtimeSessionSync.record(session, []);
    if (scenario === "mixed pending messages") {
      context.messages.push({ role: "system", content: "new instruction", timestamp: 3 });
    }
    const model = {
      id: "test-model", name: "Test model", api: "agy", provider: "agy",
      baseUrl: "agy", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192, maxTokens: 1024,
    } as Model<any>;
    const events: AssistantMessageEvent[] = [];
    for await (const event of streamAgyProvider(model, context, {
      sessionId: "continue-regression", signal: controller.signal,
      env: { AGY_BRIDGE_LOGIN_EPOCH: "current-login" },
      ...(scenario === "payload abort" ? {
        onPayload: async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          controller.abort();
          return { prompt: "must not be sent" };
        },
      } : {}),
    }, config, bridge)) {
      events.push(event);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(restore.mock.calls[0]!.arguments, [session.piSessionId, "current-login"]);
    assert.equal(resolve.mock.callCount(), row.pending ? 1 : 0);
    if (row.pending) assert.deepEqual(resolve.mock.calls[0]!.arguments, [
      context.messages.filter((message) => message.role === "toolResult"),
      scenario === "mixed pending messages"
        ? JSON.stringify({ purpose: "pending_tool_continuation", messages: [{ role: "system", content: "new instruction" }] })
        : ["queued calls without results", "error while tools pending"].includes(scenario)
          ? JSON.stringify({ purpose: "pending_tool_continuation", messages: [{ role: "user", content: "latest request" }] })
          : undefined,
    ]);
    assert.equal(unsubscribe.mock.callCount(), 1);
    assert.equal(listener, undefined);
    assert.equal(send.mock.callCount(), row.sends);
    assert.equal(persist.mock.callCount(), row.persists);
    assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), row.synced);
    if (row.reason === "stop") {
      assert.equal(events.at(-1)?.type, "done");
      assert.equal(events.some((event) => event.type === "error"), false);
      assert.equal(invalidate.mock.callCount(), 0);
      assert.deepEqual(persist.mock.calls[0]!.arguments, [
        session.piSessionId, { conversationId: "old-conversation", hasPendingToolCalls: true }, context.messages, "current-login",
      ]);
      const terminal = events.at(-1);
      assert.ok(terminal?.type === "done");
      assert.equal(terminal.reason, row.reason);
      assert.deepEqual(persist.mock.calls[1]!.arguments[2], [...context.messages, terminal.message]);
      assert.equal(persist.mock.calls[1]!.arguments[3], "current-login");
      assert.equal(session.activeProcess, proc);
      assert.equal(close.mock.callCount(), 0);
      assert.equal(abort.mock.callCount(), 0);
    } else {
      const terminal = events.at(-1);
      assert.ok(terminal?.type === "error");
      assert.equal(terminal.reason, row.reason);
      if (row.reason === "error") {
        assert.equal(terminal.error.errorMessage, row.error);
        assert.equal(invalidate.mock.callCount(), 1);
        assert.deepEqual(invalidate.mock.calls[0]!.arguments, [session.piSessionId]);
        if (row.persists > 0) {
          assert.deepEqual(persist.mock.calls.at(-1)!.arguments[2], context.messages, "preserve only the accepted-result checkpoint, never a failed infrastructure assistant");
          assert.equal(row.synced, context.messages.length);
        }
      } else {
        assert.equal(invalidate.mock.callCount(), 0, "nonpending user abort does not invalidate a saved reference");
      }
      assert.equal(session.activeProcess, null);
      assert.equal(session.activeMcpServer, null);
      assert.equal(close.mock.callCount(), 1);
      assert.equal(abort.mock.callCount(), 1);
      await bridge.liveSessions.disposeAll();
      assert.equal(close.mock.callCount(), 1);
      assert.equal(abort.mock.callCount(), 1);
    }
  });
}

const pendingTerminalCases: {
  scenario: string;
  enqueued: boolean;
  result: AgyResultEvent;
  reason: "aborted" | "stop";
}[] = [
  { scenario: "ABORTED before result delivery", enqueued: false, result: { event: "result", result: { status: "ABORTED", error: { message: "Native cancellation" } } }, reason: "aborted" },
  { scenario: "ABORTED after results enqueued", enqueued: true, result: { event: "result", result: { status: "ABORTED", error: { message: "Native cancellation" } } }, reason: "aborted" },
  { scenario: "SUCCESS before result delivery", enqueued: false, result: { event: "result", result: { status: "SUCCESS" } }, reason: "stop" },
  { scenario: "SUCCESS after results enqueued", enqueued: true, result: { event: "result", result: { status: "SUCCESS" } }, reason: "stop" },
];

for (const row of pendingTerminalCases) {
  test(`streamAgyProvider invalidates native ${row.scenario} with other MCP calls pending`, { timeout: 5000 }, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-pending-terminal-"));
    const pi = {
      on: () => {}, registerProvider: () => {}, registerCommand: () => {},
      getActiveTools: () => [], getAllTools: () => [],
    } as unknown as ExtensionAPI;
    const config = { agyPath: path.join(directory, "agy"), pluginDir: directory, models: [] };
    const bridge = new AgyBridge(pi, config);
    t.after(async () => {
      try {
        await bridge.liveSessions.disposeAll();
      } finally {
        t.mock.restoreAll();
        await rm(directory, { recursive: true, force: true });
      }
    });
    await writeFile(config.agyPath, '#!/bin/sh\necho 1.2.14\n', { mode: 0o755 });
    const close = t.mock.method(BridgeIPC.prototype, "close", async () => {});
    const abort = t.mock.method(AgyRuntime.prototype, "abort", async () => {});
    const send = t.mock.method(AgyRuntime.prototype, "send", async () => {});
    let listener: Parameters<AgyRuntime["onEvent"]>[0] | undefined;
    const unsubscribe = t.mock.fn(() => { listener = undefined; });
    t.mock.method(AgyRuntime.prototype, "onEvent", (callback: Parameters<AgyRuntime["onEvent"]>[0]) => {
      listener = callback;
      return unsubscribe;
    });
    t.mock.getter(BridgeIPC.prototype, "hasPendingCalls", () => true);
    t.mock.method(bridge.runtimeSessionSync, "decide", () => ({ action: "continue" }) as RuntimeSessionDecision);
    bridge.start();
    const manager = SessionManager.inMemory(directory);
    const sessionId = bridge.piContextAdapter.bind(manager);
    const session = bridge.liveSessions.getOrCreate(sessionId);
    const proc = new AgyRuntime({ agentName: "pi-bridge", model: "test-model" });
    const mcp = new BridgeIPC([], session.id, session.resources);
    session.setSession(proc, "old-sync-key", mcp, "old-conversation");
    const context: Context = {
      messages: row.enqueued
        ? [{ role: "toolResult", toolCallId: "pending-call", toolName: "test-tool", content: [{ type: "text", text: "tool answer" }], isError: false, timestamp: 2 }]
        : [{ role: "user", content: "latest request", timestamp: 2 }],
      tools: [],
    };
    const epoch = "current-login";
    bridge.runtimeSessionSync.record(session, []);
    await bridge.runtimeSessionStore.set(sessionId, { conversationId: "old-conversation" }, [], epoch);
    const record = t.mock.method(bridge.runtimeSessionSync, "record", bridge.runtimeSessionSync.record.bind(bridge.runtimeSessionSync));
    const persist = t.mock.method(bridge.runtimeSessionStore, "set", bridge.runtimeSessionStore.set.bind(bridge.runtimeSessionStore));
    const invalidate = t.mock.method(bridge.runtimeSessionStore, "delete", bridge.runtimeSessionStore.delete.bind(bridge.runtimeSessionStore));
    const resolve = t.mock.method(BridgeIPC.prototype, "resolveToolResults", () => {
      assert.ok(listener, "subscribe before delivering results");
      const captured = listener;
      if (row.enqueued) {
        setImmediate(() => captured(row.result, "agy"));
        return 1;
      }
      captured(row.result, "agy");
      return 0;
    });
    const model = {
      id: "test-model", name: "Test", api: "agy", provider: "agy", baseUrl: "agy",
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192, maxTokens: 1024,
    } as Model<any>;

    const events: AssistantMessageEvent[] = [];
    for await (const event of streamAgyProvider(model, context, {
      sessionId, env: { AGY_BRIDGE_LOGIN_EPOCH: epoch },
    }, config, bridge)) events.push(event);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const terminal = events.at(-1);
    assert.ok(terminal?.type === "done" || terminal?.type === "error");
    assert.equal(terminal.reason, row.reason, "runtime invalidation must preserve the native terminal reason for Pi");
    if (row.reason === "aborted") {
      assert.ok(terminal.type === "error");
      assert.equal(terminal.error.stopReason, "aborted");
      assert.equal(terminal.error.errorMessage, "Native cancellation");
    } else {
      assert.ok(terminal.type === "done");
      assert.equal(terminal.message.stopReason, "stop");
    }
    assert.equal(events.filter((event) => event.type === "done" || event.type === "error").length, 1);
    assert.equal(send.mock.callCount(), 0);
    assert.equal(resolve.mock.callCount(), 1);
    assert.deepEqual(resolve.mock.calls[0]!.arguments, [
      row.enqueued ? context.messages : [],
      row.enqueued ? undefined : JSON.stringify({ purpose: "pending_tool_continuation", messages: [{ role: "user", content: "latest request" }] }),
    ]);
    assert.equal(record.mock.callCount(), row.enqueued ? 1 : 0);
    assert.equal(persist.mock.callCount(), row.enqueued ? 1 : 0);
    assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), row.enqueued ? context.messages.length : 0);
    if (row.enqueued) {
      assert.deepEqual(record.mock.calls[0]!.arguments, [session, context.messages]);
      assert.deepEqual(persist.mock.calls[0]!.arguments, [sessionId, { conversationId: "old-conversation", hasPendingToolCalls: true }, context.messages, epoch]);
    }
    assert.equal(invalidate.mock.callCount(), 1);
    assert.deepEqual(invalidate.mock.calls[0]!.arguments, [sessionId]);
    assert.equal(await bridge.runtimeSessionStore.get(sessionId, epoch), undefined);
    assert.equal(session.activeProcess, null);
    assert.equal(session.activeMcpServer, null);
    assert.equal(unsubscribe.mock.callCount(), 1);
    assert.equal(listener, undefined);
    assert.equal(close.mock.callCount(), 1);
    assert.equal(abort.mock.callCount(), 1);
    await bridge.liveSessions.disposeAll();
    assert.equal(close.mock.callCount(), 1);
    assert.equal(abort.mock.callCount(), 1);
  });
}

const pendingContextCases: {
  name: string;
  roles: ("user" | "system")[];
  sections?: Record<string, string | null>;
  isError?: boolean;
}[] = [
  ...([["user"], ["system"], ["user", "system"], ["system", "user", "system"]] as const)
    .map((roles) => ({ name: roles.join(" then "), roles: [...roles] })),
  ...[false, true].map((isError) => ({
    name: `section removal with tool isError=${isError}`,
    roles: ["system" as const], sections: { policy: null }, isError,
  })),
];

for (const { name, roles, sections, isError = false } of pendingContextCases) {
  test(`pending tool results continue through MCP with appended ${name}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-mixed-pending-"));
    const pi = {
      on: () => {}, registerProvider: () => {}, registerCommand: () => {},
      getActiveTools: () => [], getAllTools: () => [],
    } as unknown as ExtensionAPI;
    const config = { agyPath: path.join(directory, "agy"), pluginDir: path.join(directory, "plugin"), models: [] };
    const bridge = new AgyBridge(pi, config);
    t.after(async () => {
      try {
        await bridge.liveSessions.disposeAll();
      } finally {
        t.mock.restoreAll();
        await rm(directory, { recursive: true, force: true });
      }
    });
    await writeFile(config.agyPath, '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo 1.2.14\nelse\n  exit 1\nfi\n', { mode: 0o755 });
    bridge.start();
    const session = bridge.liveSessions.getOrCreate("mixed-pending");
    const oldProc = new AgyRuntime({ agentName: "pi-bridge", model: "test-model" });
    const oldMcp = new BridgeIPC([], session.id, session.resources);
    const model = {
      id: "test-model", name: "Test model", api: "agy", provider: "agy",
      baseUrl: "agy", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192, maxTokens: 1024,
    } as Model<any>;
    const prefix: Context["messages"] = [
      { role: "user", content: "original request", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "pending-call", name: "test-tool", arguments: {} }],
        api: "agy", provider: "agy", model: "test-model", responseId: "old-conversation",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse", timestamp: 2 },
    ];
    const instructions = roles.map((role, index) => ({
      role, content: `additional instruction ${index}`, timestamp: 4 + index,
      ...(role === "system" && sections ? { sections } : {}),
    }));
    const context: Context = { systemPrompt: "Rules", tools: [], messages: [
      ...prefix,
      { role: "toolResult", toolCallId: "pending-call", toolName: "test-tool", content: [{ type: "text", text: "pending tool answer" }], isError, timestamp: 3 },
      ...instructions,
    ] };
    session.setSession(oldProc, calculateSyncKey("Rules", [], "test-model", "", "pi-bridge"), oldMcp, "old-conversation");
    bridge.runtimeSessionSync.record(session, prefix);

    const listeners = new Map<AgyRuntime, Parameters<AgyRuntime["onEvent"]>[0]>();
    t.mock.getter(AgyRuntime.prototype, "isRunning", () => true);
    let pending = true;
    t.mock.getter(BridgeIPC.prototype, "hasPendingCalls", function (this: BridgeIPC) { return this === oldMcp && pending; });
    t.mock.method(BridgeIPC.prototype, "start", async () => { throw new Error("unexpected MCP start"); });
    const close = t.mock.method(BridgeIPC.prototype, "close", async () => {});
    const abort = t.mock.method(AgyRuntime.prototype, "abort", async () => {});
    const start = t.mock.method(AgyRuntime.prototype, "start", async () => { throw new Error("unexpected runtime start"); });
    t.mock.method(AgyRuntime.prototype, "onEvent", function (this: AgyRuntime, listener: Parameters<AgyRuntime["onEvent"]>[0]) {
      listeners.set(this, listener);
      return () => { listeners.delete(this); };
    });
    const send = t.mock.method(AgyRuntime.prototype, "send", async () => { throw new Error("pending results must not resend a prompt"); });

    const resolve = t.mock.method(BridgeIPC.prototype, "resolveToolResults", function (this: BridgeIPC, _results: Context["messages"], _appendix?: string) {
      assert.equal(this, oldMcp);
      const listener = listeners.get(oldProc);
      assert.ok(listener, "subscribe before resuming MCP");
      setImmediate(() => {
        pending = false;
        listener({ event: "step_update", delta: "finished" }, "agy");
        listener({ event: "result", status: "success" }, "agy");
      });
      return 1;
    });
    const persist = t.mock.method(bridge.runtimeSessionStore, "set", async () => {});

    const events: AssistantMessageEvent[] = [];
    for await (const event of streamAgyProvider(model, context, { sessionId: session.piSessionId }, config, bridge)) events.push(event);
    assert.equal(events.some((event) => event.type === "error"), false);
    const terminal = events.at(-1);
    assert.ok(terminal?.type === "done");
    assert.equal(terminal.reason, "stop");
    assert.equal(start.mock.callCount(), 0);
    assert.equal(send.mock.callCount(), 0);
    assert.equal(close.mock.callCount(), 0);
    assert.equal(abort.mock.callCount(), 0);
    assert.equal(session.activeProcess, oldProc);
    assert.equal(session.conversationId, "old-conversation");
    assert.equal(resolve.mock.callCount(), 1);
    const [results, appendix] = resolve.mock.calls[0]!.arguments;
    assert.deepEqual(results, [context.messages[prefix.length]]);
    assert.equal(typeof appendix, "string");
    assert.deepEqual(JSON.parse(appendix!), {
      purpose: "pending_tool_continuation",
      messages: instructions.map(({ role, content, sections }) => ({ role, content, ...(sections ? { sections } : {}) })),
    });
    assert.equal(persist.mock.callCount(), 2);
    assert.deepEqual(persist.mock.calls[0]!.arguments[2], context.messages);
    assert.deepEqual(persist.mock.calls[1]!.arguments[2], [...context.messages, terminal.message]);
    assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), context.messages.length + 1);
    assert.equal(listeners.size, 0);
    await bridge.liveSessions.disposeAll();
    assert.equal(close.mock.callCount(), 1);
    assert.equal(abort.mock.callCount(), 1);
    assert.equal(session.activeProcess, null);
  });
}

for (const conversionException of [false, true]) {
  test(conversionException
    ? "real gateway conversion exception returns a tool error and continues without runtime invalidation"
    : "queued tool batch opens only after old mixed results are delivered and persisted", { timeout: 5000 }, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-queued-turn-"));
    const pi = {
      on: () => {}, registerProvider: () => {}, registerCommand: () => {},
      getActiveTools: () => [], getAllTools: () => [],
    } as unknown as ExtensionAPI;
    const config = { agyPath: path.join(directory, "agy"), pluginDir: directory, models: [] };
    const bridge = new AgyBridge(pi, config);
    t.after(async () => {
      try {
        await bridge.liveSessions.disposeAll();
      } finally {
        t.mock.restoreAll();
        await rm(directory, { recursive: true, force: true });
      }
    });
    await writeFile(config.agyPath, '#!/bin/sh\necho 1.2.14\n', { mode: 0o755 });
    const close = t.mock.method(BridgeIPC.prototype, "close", async () => {});
    const abort = t.mock.method(AgyRuntime.prototype, "abort", async () => {});
    t.mock.method(AgyRuntime.prototype, "onEvent", () => () => {});
    const send = t.mock.method(AgyRuntime.prototype, "send", async () => {});
    const start = t.mock.method(AgyRuntime.prototype, "start", async () => { throw new Error("unexpected start"); });
    const rebuild = t.mock.method(BridgeIPC.prototype, "start", async () => { throw new Error("unexpected rebuild"); });
    t.mock.method(bridge.runtimeSessionSync, "decide", () => ({ action: "continue" }) as RuntimeSessionDecision);
    bridge.start();
    const manager = SessionManager.inMemory(directory);
    const sessionId = bridge.piContextAdapter.bind(manager);
    const session = bridge.liveSessions.getOrCreate(sessionId);
    const toolName = conversionException ? "pty" : "test-tool";
    const tools = [{ name: toolName, description: "test", parameters: { type: "object", properties: {} } }];
    t.mock.method(bridge, "getTools", () => tools);
    const gateway = new CapabilityGateway(tools, session.resources);
    t.after(() => gateway.cancelPendingCalls("test cleanup"));
    t.mock.getter(BridgeIPC.prototype, "hasPendingCalls", () => gateway.hasPendingCalls);
    const order: string[] = [];
    t.mock.method(BridgeIPC.prototype, "setToolCallHandler", (handler: Parameters<BridgeIPC["setToolCallHandler"]>[0]) => {
      if (handler) order.push("install");
      gateway.setToolCallHandler(handler);
    });
    t.mock.method(BridgeIPC.prototype, "resolveToolResults", (messages: Context["messages"], appendix?: string) => {
      order.push("resolve");
      return gateway.resolveToolResults(messages, appendix);
    });
    const invalidate = t.mock.method(bridge.runtimeSessionStore, "delete", bridge.runtimeSessionStore.delete.bind(bridge.runtimeSessionStore));
    const setReference = bridge.runtimeSessionStore.set.bind(bridge.runtimeSessionStore);
    const persist = t.mock.method(bridge.runtimeSessionStore, "set", async (...args: Parameters<typeof setReference>) => {
      order.push("persist");
      const ref = await setReference(...args);
      await new Promise<void>((resolve) => setImmediate(resolve));
      return ref;
    });
    const proc = new AgyRuntime({ agentName: "pi-bridge", model: "test-model" });
    session.setSession(proc, "old-sync-key", new BridgeIPC([], session.id, session.resources), "old-conversation");
    let oldId = "";
    gateway.setToolCallHandler((batch) => {
      oldId = batch.calls[0]!.id;
      gateway.setToolCallHandler(null);
      batch.complete();
    });
    const oldResult = gateway.call(toolName, { batch: "old", ...(conversionException ? { operation: "start" } : {}) });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(oldId);
    const nextResult = gateway.call(toolName, { batch: "next" });
    const context: Context = {
      messages: [
        { role: "toolResult", toolCallId: oldId, toolName,
          content: [{ type: "text", text: conversionException ? undefined as unknown as string : "old answer" }],
          isError: false, timestamp: 1 },
        { role: "system", content: "new instruction", timestamp: 2 },
      ], tools: [],
    };
    bridge.runtimeSessionSync.record(session, []);
    const model = {
      id: "test-model", name: "Test", api: "agy", provider: "agy", baseUrl: "agy",
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192, maxTokens: 1024,
    } as Model<any>;
    const events: AssistantMessageEvent[] = [];
    for await (const event of streamAgyProvider(model, context, { sessionId }, config, bridge)) events.push(event);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["resolve", "persist", "install", "persist"]);
    const delivered = await oldResult;
    assert.ok(delivered.content[0]?.type === "text");
    if (conversionException) {
      assert.equal(delivered.isError, true);
      assert.match(delivered.content[0].text, /Cannot read properties of undefined.*replace/);
    } else {
      assert.equal(delivered.isError, false);
      assert.ok(JSON.stringify(delivered).includes("old answer"));
    }
    assert.ok(JSON.stringify(delivered).includes("new instruction"));
    const terminal = events.at(-1);
    assert.ok(terminal?.type === "done");
    assert.equal(terminal.reason, "toolUse");
    const call = terminal.message.content[0];
    assert.ok(call?.type === "toolCall");
    assert.notEqual(call.id, oldId);
    assert.deepEqual(call.arguments, { batch: "next" });
    assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), context.messages.length + 1);
    assert.deepEqual(persist.mock.calls[1]!.arguments[2], [...context.messages, terminal.message]);
    assert.equal(session.activeProcess, proc);
    assert.equal(invalidate.mock.callCount(), 0, "conversion is a tool error, not an infrastructure failure");
    assert.equal(close.mock.callCount(), 0);
    assert.equal(abort.mock.callCount(), 0);
    assert.equal(send.mock.callCount(), 0);
    assert.equal(start.mock.callCount(), 0);
    assert.equal(rebuild.mock.callCount(), 0);
    assert.equal(gateway.resolveToolResults([{ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "next answer" }], isError: false, timestamp: 3 }]), 1);
    assert.ok(JSON.stringify(await nextResult).includes("next answer"));
    assert.equal((await bridge.runtimeSessionStore.get(sessionId))?.conversationId, "old-conversation");
    if (conversionException) return;

    // The completed toolUse adapter must not release runtime failure ownership.
    const ownedBridge = session.activeMcpServer!;
    const failureHandler = (ownedBridge as unknown as {
      transportFailureHandler: (error: Error) => void;
    }).transportFailureHandler;
    assert.equal(typeof failureHandler, "function");
    const checkpoint = bridge.runtimeSessionSync.getSyncedMessageCount(session);
    failureHandler(new Error("write callback failed during pending gap"));
    assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), checkpoint);
    assert.equal(session.activeProcess, null);
    assert.equal(session.activeMcpServer, null);
    assert.equal(invalidate.mock.callCount(), 1);
    assert.deepEqual(invalidate.mock.calls[0]!.arguments, [session.piSessionId]);
    assert.equal(await bridge.runtimeSessionStore.get(sessionId), undefined);

    const replacement = new AgyRuntime({ agentName: "pi-bridge", model: "test-model" });
    const replacementBridge = new BridgeIPC([], session.id, session.resources);
    session.setSession(replacement, "replacement", replacementBridge, "replacement-conversation");
    await setReference(sessionId, { conversationId: "replacement-conversation" }, context.messages);
    failureHandler(new Error("late old callback"));
    assert.equal(session.activeProcess, replacement);
    assert.equal(session.activeMcpServer, replacementBridge);
    assert.equal(invalidate.mock.callCount(), 1);
    assert.equal((await bridge.runtimeSessionStore.get(sessionId))?.conversationId, "replacement-conversation");
  });
}
