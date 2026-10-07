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
import type { AgyEvent, AgyInput } from "../shared/types.ts";
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
    const wait = t.mock.method(BridgeIPC.prototype, "waitForConnection", async () => {});
    const close = t.mock.method(BridgeIPC.prototype, "close", async () => {});
    const getEnvironment = t.mock.getter(BridgeIPC.prototype, "processEnvironment", () => environment);
    const install = t.mock.method(AgyBridge.prototype, "ensureAgyPluginInstalled", async () => {});
    const startProc = t.mock.method(AgyRuntime.prototype, "start", async () => ({
      event: "init", conversation_id: decision.action === "resume" ? "old-conversation" : "new-conversation",
    }) as Awaited<ReturnType<AgyRuntime["start"]>>);
    const abort = t.mock.method(AgyRuntime.prototype, "abort", async () => {});
    const listeners = new Map<AgyRuntime, (event: AgyEvent) => void>();
    const unsubscribe = t.mock.fn(() => {});
    t.mock.method(AgyRuntime.prototype, "onEvent", function (this: AgyRuntime, listener: (event: AgyEvent) => void) {
      listeners.set(this, listener);
      return () => {
        listeners.delete(this);
        unsubscribe();
      };
    });
    const send = t.mock.method(AgyRuntime.prototype, "send", async function (this: AgyRuntime, _input: AgyInput) {
      const listener = listeners.get(this);
      assert.ok(listener, "provider must subscribe before sending");
      listener({ event: "step_update", delta: "success answer" });
      listener({ event: "result", status: "success" });
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
    assert.equal(liveSession.turnIndex, 1);
    assert.equal(persist.mock.callCount(), 1);
    const starts = decision.action === "continue" ? 0 : 1;
    assert.equal(startProc.mock.callCount(), starts);
    assert.equal(startBridge.mock.callCount(), starts);
    assert.equal(wait.mock.callCount(), starts);
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

for (const scenario of ["pending tool results", "mixed pending messages", "missing result", "unmatched result", "conversion error", "transport failure", "abort", "payload abort"] as const) {
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
    let listener: ((event: AgyEvent) => void) | undefined;
    const unsubscribe = t.mock.fn(() => { listener = undefined; });
    t.mock.method(AgyRuntime.prototype, "onEvent", (callback: (event: AgyEvent) => void) => {
      listener = callback;
      return unsubscribe;
    });
    const send = t.mock.method(AgyRuntime.prototype, "send", async () => {
      assert.ok(listener, "provider must subscribe before sending");
      controller.abort();
    });
    t.mock.getter(BridgeIPC.prototype, "hasPendingCalls", () => ["pending tool results", "mixed pending messages", "missing result", "unmatched result", "conversion error", "transport failure"].includes(scenario));
    const resolve = t.mock.method(BridgeIPC.prototype, "resolveToolResults", (_results: Context["messages"], _appendix?: string) => {
      assert.ok(listener, "provider must subscribe before resolving tool results");
      if (scenario === "conversion error") throw new Error("result conversion failed");
      if (["abort", "payload abort", "missing result", "unmatched result"].includes(scenario)) return 0;
      const captured = listener;
      setImmediate(() => {
        if (scenario === "transport failure") {
          (mcp as unknown as { failTransport(error: Error): void }).failTransport(new Error("MCP write failed"));
        } else {
          captured({ event: "result", status: "success" });
        }
      });
      return 1;
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
      messages: ["pending tool results", "mixed pending messages", "unmatched result", "conversion error", "transport failure"].includes(scenario)
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
    const pending = scenario !== "abort" && scenario !== "payload abort";
    assert.equal(resolve.mock.callCount(), pending ? 1 : 0);
    if (pending) assert.deepEqual(resolve.mock.calls[0]!.arguments, [
      context.messages.filter((message) => message.role === "toolResult"),
      scenario === "mixed pending messages"
        ? JSON.stringify({ purpose: "pending_tool_continuation", messages: [{ role: "system", content: "new instruction" }] })
        : scenario === "missing result"
          ? JSON.stringify({ purpose: "pending_tool_continuation", messages: [{ role: "user", content: "latest request" }] })
          : undefined,
    ]);
    assert.equal(unsubscribe.mock.callCount(), 1);
    assert.equal(listener, undefined);
    if (scenario === "pending tool results" || scenario === "mixed pending messages") {
      assert.equal(send.mock.callCount(), 0);
      assert.equal(events.at(-1)?.type, "done");
      assert.equal(events.some((event) => event.type === "error"), false);
      assert.equal(session.turnIndex, 1);
      assert.equal(persist.mock.callCount(), 2);
      assert.deepEqual(persist.mock.calls[0]!.arguments, [
        session.piSessionId, { conversationId: "old-conversation" }, context.messages, "current-login",
      ]);
      const terminal = events.at(-1);
      assert.ok(terminal?.type === "done");
      assert.deepEqual(persist.mock.calls[1]!.arguments[2], [...context.messages, terminal.message]);
      assert.equal(persist.mock.calls[1]!.arguments[3], "current-login");
      assert.equal(session.activeProcess, proc);
      assert.equal(close.mock.callCount(), 0);
      assert.equal(abort.mock.callCount(), 0);
    } else {
      assert.equal(send.mock.callCount(), scenario === "abort" ? 1 : 0);
      const terminal = events.at(-1);
      assert.ok(terminal?.type === "error");
      const failed = ["missing result", "unmatched result", "conversion error", "transport failure"].includes(scenario);
      assert.equal(terminal.reason, failed ? "error" : "aborted");
      if (failed) {
        assert.match(terminal.error.errorMessage ?? "", /no matching result|not enqueued|conversion failed|MCP write failed/);
        assert.equal(invalidate.mock.callCount(), 1);
        assert.deepEqual(invalidate.mock.calls[0]!.arguments, [session.piSessionId]);
        assert.equal(persist.mock.callCount(), scenario === "transport failure" ? 1 : 0);
        assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), scenario === "transport failure" ? 1 : 0);
      }
      assert.equal(session.activeProcess, null);
      assert.equal(close.mock.callCount(), 1);
      assert.equal(abort.mock.callCount(), 1);
      await bridge.liveSessions.disposeAll();
      assert.equal(close.mock.callCount(), 1);
      assert.equal(abort.mock.callCount(), 1);
    }
  });
}

for (const roles of [["user"], ["system"], ["user", "system"], ["system", "user", "system"]] as const) {
  test(`pending tool results continue through MCP with appended ${roles.join(" then ")}`, async (t) => {
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
    const instructions = roles.map((role, index) => ({ role, content: `additional instruction ${index}`, timestamp: 4 + index }));
    const context: Context = { systemPrompt: "Rules", tools: [], messages: [
      ...prefix,
      { role: "toolResult", toolCallId: "pending-call", toolName: "test-tool", content: [{ type: "text", text: "pending tool answer" }], isError: false, timestamp: 3 },
      ...instructions,
    ] };
    session.setSession(oldProc, calculateSyncKey("Rules", [], "test-model", "", "pi-bridge"), oldMcp, "old-conversation");
    session.turnIndex = 1;
    bridge.runtimeSessionSync.record(session, prefix);

    const lifecycle: string[] = [];
    const listeners = new Map<AgyRuntime, (event: AgyEvent) => void>();
    t.mock.getter(AgyRuntime.prototype, "isRunning", () => true);
    t.mock.getter(BridgeIPC.prototype, "hasPendingCalls", function (this: BridgeIPC) { return this === oldMcp; });
    t.mock.getter(BridgeIPC.prototype, "processEnvironment", () => ({}));
    t.mock.method(AgyBridge.prototype, "ensureAgyPluginInstalled", async () => {});
    t.mock.method(BridgeIPC.prototype, "start", async () => { lifecycle.push("mcp-start"); });
    t.mock.method(BridgeIPC.prototype, "waitForConnection", async () => {});
    const close = t.mock.method(BridgeIPC.prototype, "close", async function (this: BridgeIPC) {
      lifecycle.push(this === oldMcp ? "old-close" : "new-close");
    });
    const abort = t.mock.method(AgyRuntime.prototype, "abort", async function (this: AgyRuntime) {
      lifecycle.push(this === oldProc ? "old-abort" : "new-abort");
    });
    const start = t.mock.method(AgyRuntime.prototype, "start", async () => {
      lifecycle.push("start");
      return { event: "init", conversation_id: "new-conversation" } as Awaited<ReturnType<AgyRuntime["start"]>>;
    });
    t.mock.method(AgyRuntime.prototype, "onEvent", function (this: AgyRuntime, listener: (event: AgyEvent) => void) {
      listeners.set(this, listener);
      return () => { listeners.delete(this); };
    });
    const send = t.mock.method(AgyRuntime.prototype, "send", async function (this: AgyRuntime, _input: AgyInput) {
      assert.equal(this, oldProc);
      lifecycle.push("send");
      const listener = listeners.get(this);
      assert.ok(listener);
      listener({ event: "step_update", delta: "finished" });
      listener({ event: "result", status: "success" });
    });

    const resolve = t.mock.method(BridgeIPC.prototype, "resolveToolResults", function (this: BridgeIPC, _results: Context["messages"], _appendix?: string) {
      assert.equal(this, oldMcp);
      const listener = listeners.get(oldProc);
      assert.ok(listener, "subscribe before resuming MCP");
      setImmediate(() => {
        listener({ event: "step_update", delta: "finished" });
        listener({ event: "result", status: "success" });
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
    assert.deepEqual(lifecycle, []);
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
      messages: instructions.map(({ role, content }) => ({ role, content })),
    });
    assert.doesNotMatch(appendix!, /pending tool answer|original request/);
    for (const { content } of instructions) assert.equal(appendix!.split(content).length - 1, 1);
    assert.equal(persist.mock.callCount(), 2);
    assert.deepEqual(persist.mock.calls[0]!.arguments[2], context.messages);
    assert.deepEqual(persist.mock.calls[1]!.arguments[2], [...context.messages, terminal.message]);
    assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), context.messages.length + 1);
    assert.equal(session.turnIndex, 2);
    assert.equal(listeners.size, 0);
    await bridge.liveSessions.disposeAll();
    assert.equal(close.mock.callCount(), 1);
    assert.equal(abort.mock.callCount(), 1);
    assert.equal(session.activeProcess, null);
  });
}

test("queued tool batch opens only after old mixed results are delivered and persisted", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agy-queued-turn-"));
  const pi = {
    on: () => {}, registerProvider: () => {}, registerCommand: () => {},
    getActiveTools: () => [], getAllTools: () => [],
  } as unknown as ExtensionAPI;
  const config = { agyPath: path.join(directory, "agy"), pluginDir: directory, models: [] };
  const bridge = new AgyBridge(pi, config);
  t.after(async () => {
    await bridge.liveSessions.disposeAll();
    t.mock.restoreAll();
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(config.agyPath, '#!/bin/sh\necho 1.2.14\n', { mode: 0o755 });
  t.mock.method(BridgeIPC.prototype, "close", async () => {});
  t.mock.method(AgyRuntime.prototype, "abort", async () => {});
  t.mock.method(AgyRuntime.prototype, "onEvent", () => () => {});
  const send = t.mock.method(AgyRuntime.prototype, "send", async () => {});
  const start = t.mock.method(AgyRuntime.prototype, "start", async () => { throw new Error("unexpected start"); });
  const rebuild = t.mock.method(BridgeIPC.prototype, "start", async () => { throw new Error("unexpected rebuild"); });
  t.mock.method(bridge.runtimeSessionSync, "decide", () => ({ action: "continue" }) as RuntimeSessionDecision);
  bridge.start();
  const manager = SessionManager.inMemory(directory);
  const sessionId = bridge.piContextAdapter.bind(manager);
  const session = bridge.liveSessions.getOrCreate(sessionId);
  const tools = [{ name: "test-tool", description: "test", parameters: { type: "object", properties: {} } }];
  t.mock.method(bridge, "getTools", () => tools);
  const gateway = new CapabilityGateway(tools);
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
  const oldResult = gateway.call("test-tool", { batch: "old" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(oldId);
  const nextResult = gateway.call("test-tool", { batch: "next" });
  const context: Context = {
    messages: [
      { role: "toolResult", toolCallId: oldId, toolName: "test-tool", content: [{ type: "text", text: "old answer" }], isError: false, timestamp: 1 },
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
  assert.equal(delivered.content[0]?.type, "text");
  assert.ok(JSON.stringify(delivered).includes("old answer"));
  assert.ok(JSON.stringify(delivered).includes("new instruction"));
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "done");
  assert.ok(terminal?.type === "done");
  assert.equal(terminal.reason, "toolUse");
  const call = terminal.message.content[0];
  assert.ok(call?.type === "toolCall");
  assert.notEqual(call.id, oldId);
  assert.deepEqual(call.arguments, { batch: "next" });
  assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), context.messages.length + 1);
  assert.deepEqual(persist.mock.calls[1]!.arguments[2], [...context.messages, terminal.message]);
  assert.equal(session.activeProcess, proc);
  assert.equal(send.mock.callCount(), 0);
  assert.equal(start.mock.callCount(), 0);
  assert.equal(rebuild.mock.callCount(), 0);
  assert.equal(gateway.resolveToolResults([{ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "next answer" }], isError: false, timestamp: 3 }]), 1);
  // The completed toolUse adapter must not release runtime failure ownership.
  assert.equal((await bridge.runtimeSessionStore.get(sessionId))?.conversationId, "old-conversation");
  const ownedBridge = session.activeMcpServer!;
  const failureHandler = (ownedBridge as unknown as {
    transportFailureHandler: (error: Error) => void;
  }).transportFailureHandler;
  assert.equal(typeof failureHandler, "function");
  failureHandler(new Error("write callback failed during pending gap"));
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
  assert.ok(JSON.stringify(await nextResult).includes("next answer"));
});
