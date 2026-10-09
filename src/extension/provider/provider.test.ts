import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider, Model, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { AgyRuntime, type AgyEventSource } from "../runtime/process.ts";
import { BridgeIPC } from "../bridge/bridge-ipc.ts";
import { CapabilityGateway } from "../bridge/capabilities.ts";
import { PiEventAdapter } from "../runtime/events.ts";
import { messagesMatch } from "../session/session-state.ts";
import type { AgyEvent, AgyInput } from "../shared/types.ts";
import { AgyBridge, registerAgyProvider, resolveModelAndEffort, streamAgyProvider } from "./provider.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const allNullThinkingLevels = {
  off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null,
};

type ResolverCase = {
  name: string;
  modelId: string;
  options?: Record<string, string> | undefined;
  thinkingLevelMap?: Model<any>["thinkingLevelMap"];
  expected?: ReturnType<typeof resolveModelAndEffort>;
  error?: string;
};

const resolverCases: ResolverCase[] = [
  { name: "Gemini has no default effort", modelId: "gemini-3.8-flash", expected: { baseModel: "gemini-3.8-flash", effort: undefined } },
  { name: "explicit effort overrides suffix", modelId: "gemini-3.8-flash-low", options: { reasoningEffort: "high" }, expected: { baseModel: "gemini-3.8-flash", effort: "high" } },
  ...["reasoningEffort", "reasoning", "thinkingLevel"].flatMap((option) => [
    ...["off", "minimal", "xhigh", "max", "unknown", ""].flatMap((effort) =>
      ["other-model", "other-model-high"].map((modelId) => ({
        name: `rejects ${option}=${JSON.stringify(effort)} for ${modelId}`, modelId, options: { [option]: effort },
        error: `Unsupported Antigravity CLI reasoning effort: ${effort}. Supported values: low, medium, high.`,
      }))),
    ...(["low", "medium", "high"] as const).flatMap((effort) =>
      ["other-model", "other-model-low"].map((modelId) => ({
        name: `accepts ${option}=${effort} for ${modelId}`, modelId, options: { [option]: effort },
        expected: { baseModel: "other-model", effort },
      }))),
  ]),
  ...([
    ["other-model", "other-model", undefined],
    ["other-model-low", "other-model", "low"],
    ["other-model-medium", "other-model", "medium"],
    ["other-model-HIGH", "other-model", "high"],
  ] as const).flatMap(([modelId, baseModel, effort]) => [undefined, {}].map((options) => ({
    name: `absent effort for ${modelId} with ${JSON.stringify(options)}`, modelId, options, expected: { baseModel, effort },
  }))),
  ...["claude-sonnet-4-6", "claude-opus-4-6-thinking"].flatMap((modelId) => [undefined, {}].map((options) => ({
    name: `fixed ${modelId} with ${JSON.stringify(options)}`, modelId, options, thinkingLevelMap: allNullThinkingLevels,
    expected: { baseModel: modelId, effort: undefined },
  }))),
  ...(["low", "medium", "high"] as const).map((effort) => ({
    name: `supported Gemini ${effort}`, modelId: "gemini-3.8-flash", options: { reasoning: effort },
    thinkingLevelMap: { ...allNullThinkingLevels, low: "low", medium: "medium", high: "high" },
    expected: { baseModel: "gemini-3.8-flash", effort },
  })),
];

for (const row of resolverCases) {
  test(row.name, () => {
    const resolve = () => resolveModelAndEffort(row.modelId, row.options as SimpleStreamOptions, row.thinkingLevelMap);
    if (row.error) assert.throws(resolve, { message: row.error });
    else assert.deepEqual(resolve(), row.expected);
  });
}

const fixedEffortCases = ["claude-sonnet-4-6", "claude-opus-4-6-thinking"].flatMap((modelId) =>
  ["reasoningEffort", "reasoning", "thinkingLevel"].flatMap((option) =>
    ["low", "medium", "high"].map((effort) => ({
      name: `rejects fixed ${modelId} ${option}=${effort} before runtime preparation`,
      modelId,
      options: { [option]: effort },
      error: `Unsupported Antigravity CLI reasoning effort for ${modelId}: ${effort}.`,
    }))));

for (const row of fixedEffortCases) {
  test(row.name, async (t) => {
    const bridge = new AgyBridge({} as ExtensionAPI);
    const runtimeLookup = t.mock.method(bridge.runtimeSessionStore, "get", async () => {
      throw new Error("Runtime preparation must not begin");
    });
    const model = { id: row.modelId, provider: "agy", thinkingLevelMap: allNullThinkingLevels } as Model<any>;

    const message = await streamAgyProvider(model, { messages: [], tools: [] }, {
      sessionId: "validation-test", ...row.options,
    }, undefined, bridge).result();

    assert.equal(message.stopReason, "error");
    assert.equal(message.errorMessage, row.error);
    assert.equal(runtimeLookup.mock.callCount(), 0);
    assert.equal(bridge.liveSessions.get("validation-test"), undefined);
  });
}

test("doctor reports installation errors without starting a model turn", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agy-doctor-command-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let handler: (() => Promise<void>) | undefined;
  const sendMessage = t.mock.fn();
  const pi = {
    on: () => {},
    registerProvider: () => {},
    registerCommand: (name: string, command: { handler: () => Promise<void> }) => {
      assert.equal(name, "agy-bridge:doctor");
      handler = command.handler;
    },
    sendMessage,
  } as unknown as ExtensionAPI;
  const pluginDir = path.join(directory, "missing-plugin");
  const bridge = new AgyBridge(pi, { models: [], agyPath: "__invalid_binary_name__", pluginDir });
  bridge.start();
  await assert.rejects(bridge.ensureAgyPluginInstalled(pluginDir), /manifest not found/);

  assert.ok(handler);
  await handler();

  assert.equal(sendMessage.mock.callCount(), 1);
  const [message, options] = sendMessage.mock.calls[0]!.arguments;
  assert.equal(message.customType, "pi-agy-bridge:doctor");
  assert.equal(message.display, true);
  assert.match(message.content, /Antigravity CLI plugin manifest not found/);
  assert.match(message.content, /Authentication/);
  assert.deepEqual(options, { triggerTurn: false });
});

test("doctor clears the recorded installation error after successful installation", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-doctor-recovery-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });
  const pluginDir = path.join(home, "source");
  await mkdir(pluginDir);
  await writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({ name: "doctor-test", version: "1.0.0" }));
  const agyPath = path.join(home, "agy");
  await writeFile(agyPath, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.2.14; else echo "install denied" >&2; exit 7; fi\n', { mode: 0o755 });
  let handler: (() => Promise<void>) | undefined;
  const sendMessage = t.mock.fn();
  const pi = {
    on: () => {}, registerProvider: () => {}, sendMessage,
    registerCommand: (_name: string, command: { handler: () => Promise<void> }) => { handler = command.handler; },
  } as unknown as ExtensionAPI;
  const bridge = new AgyBridge(pi, { models: [], agyPath, pluginDir });
  bridge.start();
  await assert.rejects(bridge.ensureAgyPluginInstalled(pluginDir), /install denied/);
  assert.ok(handler);
  await handler();
  assert.match(sendMessage.mock.calls[0]!.arguments[0].content, /Last plugin error.*install denied/s);

  await writeFile(agyPath, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.2.14; fi\n');
  await bridge.ensureAgyPluginInstalled(pluginDir);
  await handler();

  const report = sendMessage.mock.calls[1]!.arguments[0].content;
  assert.match(report, /Plugin installed 1.0.0/);
  assert.doesNotMatch(report, /Last plugin error/);
});

test("registers the Antigravity CLI provider and session lifecycle without starting runtime work", async (t) => {
  const spawn = t.mock.method(cp, "spawn", () => { throw new Error("Registration must not start a process"); });
  const execFile = t.mock.method(cp, "execFile", () => { throw new Error("Registration must not execute a command"); });
  const runtimeStart = t.mock.method(AgyRuntime.prototype, "start", async () => { throw new Error("Registration must not start the runtime"); });
  syncBuiltinESMExports();
  const handlers = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  let provider: Provider | undefined;
  t.after(async () => {
    try {
      await (handlers.get("session_shutdown") as (() => Promise<void>) | undefined)?.();
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  const pi = {
    on: (event: string, handler: unknown) => handlers.set(event, handler),
    registerCommand: (name: string, options: unknown) => commands.set(name, options),
    registerProvider: (registered: Provider) => {
      provider = registered;
    },
  } as unknown as ExtensionAPI;

  registerAgyProvider(pi, { agyPath: "__invalid_binary_name__" });

  assert.ok(commands.has("agy-bridge:doctor"));
  assert.ok(provider);
  assert.equal(provider.id, "agy");
  assert.equal(provider.name, "Antigravity CLI [pi-agy-bridge]");
  assert.equal(provider.baseUrl, "agy");
  assert.ok(provider.auth.apiKey);
  assert.equal(provider.auth.apiKey.login, undefined);
  assert.ok(provider.auth.oauth);
  assert.equal(provider.auth.oauth.isSubscription, true);
  assert.equal(typeof provider.auth.oauth.login, "function");
  assert.equal(typeof provider.auth.oauth.refresh, "function");
  assert.equal(typeof provider.auth.oauth.toAuth, "function");
  assert.equal(typeof provider.auth.apiKey.check, "function");
  assert.equal(typeof provider.auth.apiKey.resolve, "function");
  const persisted = { type: "api_key" as const, env: { AGY_BRIDGE_ENABLED: "1" } };
  const catalog = provider.getModels();
  assert.deepEqual(provider.filterModels?.(catalog, persisted), catalog);
  assert.deepEqual(provider.filterModels?.(catalog, undefined), []);
  assert.ok(Array.isArray(provider.getModels()));
  assert.equal(typeof provider.refreshModels, "function");
  assert.equal(typeof provider.streamSimple, "function");
  assert.equal(typeof handlers.get("session_start"), "function");
  assert.equal(typeof handlers.get("session_shutdown"), "function");

  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(execFile.mock.callCount(), 0);
  assert.equal(runtimeStart.mock.callCount(), 0);
});

test("explicit Antigravity CLI models are native static models preserving configured fields", () => {
  let provider: Provider | undefined;
  const configured = {
    id: "custom", name: "Custom", reasoning: true, input: ["text"] as ("text" | "image")[],
    contextWindow: 12345, maxTokens: 678,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  };
  registerAgyProvider({
    on: () => {}, registerCommand: () => {},
    registerProvider: (registered: Provider) => { provider = registered; },
  } as unknown as ExtensionAPI, { models: [configured], agyPath: "__invalid_binary_name__" });

  assert.ok(provider);
  assert.equal(provider.refreshModels, undefined);
  assert.deepEqual(provider.getModels(), [{
    ...configured, api: "agy", provider: "agy", baseUrl: "agy", type: "chat",
  }]);
});

async function createRuntimeFixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agy-provider-test-"));
  let bridge: AgyBridge | undefined;
  t.after(async () => {
    try {
      await bridge?.liveSessions.disposeAll();
    } finally {
      t.mock.restoreAll();
      await rm(directory, { recursive: true, force: true });
    }
  });

  const config = { agyPath: path.join(directory, "agy"), pluginDir: path.join(directory, "plugin"), models: [] };
  await writeFile(config.agyPath, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.2.14; else exit 1; fi\n', { mode: 0o755 });
  const pi = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
  let runtimeBridge = new AgyBridge(pi, config);
  bridge = runtimeBridge;
  const manager = SessionManager.inMemory("/workspace");
  const sessionId = runtimeBridge.piContextAdapter.bind(manager);
  const session = runtimeBridge.liveSessions.getOrCreate(sessionId);
  const epoch = "test-login";
  await runtimeBridge.runtimeSessionStore.set(sessionId, { conversationId: "conversation-1" }, [], epoch);

  t.mock.method(BridgeIPC.prototype, "start", async () => {});
  t.mock.method(BridgeIPC.prototype, "waitForConnection", async () => {});
  t.mock.getter(BridgeIPC.prototype, "processEnvironment", () => ({}));
  t.mock.method(AgyBridge.prototype, "ensureAgyPluginInstalled", async () => {});
  t.mock.getter(AgyRuntime.prototype, "isRunning", () => true);
  const close = t.mock.method(BridgeIPC.prototype, "close", async () => {});
  const abort = t.mock.method(AgyRuntime.prototype, "abort", async () => {});
  const processes: AgyRuntime[] = [];
  const start = t.mock.method(AgyRuntime.prototype, "start", async function (this: AgyRuntime) {
    processes.push(this);
    return {
      event: "init", conversation_id: this.options.conversationId ?? `conversation-${processes.length}`,
    } as Awaited<ReturnType<AgyRuntime["start"]>>;
  });
  const listeners = new Map<AgyRuntime, Parameters<AgyRuntime["onEvent"]>[0]>();
  const capturedListeners = new Map<AgyRuntime, Parameters<AgyRuntime["onEvent"]>[0]>();
  t.mock.method(AgyRuntime.prototype, "onEvent", function (this: AgyRuntime, listener: Parameters<AgyRuntime["onEvent"]>[0]) {
    assert.equal(listeners.has(this), false, "a runtime owns only one event subscription");
    listeners.set(this, listener);
    capturedListeners.set(this, listener);
    return () => { listeners.delete(this); };
  });
  let response: readonly AgyEvent[] | Error = [];
  let source: AgyEventSource = "agy";
  const send = t.mock.method(AgyRuntime.prototype, "send", async function (this: AgyRuntime, _input: AgyInput) {
    const listener = listeners.get(this);
    assert.ok(listener, "subscribe before sending a turn");
    if (response instanceof Error) throw response;
    for (const event of response) listener(event, event.event === "result" ? source : "agy");
  });

  const runTurn = async (modelId: string, request: string, events: readonly AgyEvent[] | Error, eventSource: AgyEventSource = "agy", signal?: AbortSignal, options?: SimpleStreamOptions) => {
    response = events;
    source = eventSource;
    manager.appendMessage({ role: "user", content: request, timestamp: Date.now() });
    const messages = manager.buildSessionContext().messages;
    assert.ok(messages.every((message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult"));
    const context: Context = { systemPrompt: "Keep Pi history", tools: [], messages };
    const model = {
      id: modelId, name: modelId, api: "agy", provider: "agy", baseUrl: "agy", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
    } as Model<any>;

    const message = await streamAgyProvider(model, context, {
      sessionId, env: { AGY_BRIDGE_LOGIN_EPOCH: epoch }, ...(signal ? { signal } : {}), ...options,
    }, config, runtimeBridge).result();

    manager.appendMessage(message);
    return message;
  };

  const restartBridge = async () => {
    await runtimeBridge.liveSessions.disposeAll();
    runtimeBridge = new AgyBridge(pi, config);
    bridge = runtimeBridge;
    assert.equal(runtimeBridge.piContextAdapter.bind(manager), sessionId);
    return { bridge: runtimeBridge, session: runtimeBridge.liveSessions.getOrCreate(sessionId) };
  };

  return { bridge: runtimeBridge, manager, session, sessionId, epoch, processes, listeners, capturedListeners, close, abort, start, send, runTurn, restartBridge };
}

const quotaError = "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h27m34s.";
const modelErrors: Array<{ name: string; events: AgyEvent[]; error: string; text: string }> = [
  { name: "quota", events: [{ event: "result", status: "error", error: quotaError }], error: quotaError, text: "" },
  { name: "arbitrary model error", events: [{ event: "result", status: "ERROR", error: { message: "Model could not answer" } }], error: "Model could not answer", text: "" },
  { name: "partial assistant text", events: [{ event: "step_update", delta: "Partial answer" }, { event: "result", status: "error", error: "Model could not finish" }], error: "Model could not finish", text: "Partial answer" },
  { name: "nested result", events: [{ event: "result", result: { status: "error", error: { message: quotaError } } }], error: quotaError, text: "" },
];
const recoveryCases = [
  { name: "same-model retry", model: "quota-model", result: { event: "result", status: "success" }, processes: 1 },
  { name: "switched-model retry", model: "other-model", result: { event: "result", status: "success" }, processes: 2 },
  { name: "switched-model explicit success carrying stale quota", model: "other-model", result: { event: "result", status: "SUCCESS", error: quotaError }, processes: 2 },
];

for (const failure of modelErrors) {
  for (const row of recoveryCases) {
    test(`provider retains conversation after ${failure.name}: ${row.name}`, async (t) => {
      const { bridge, manager, session, sessionId, epoch, processes, listeners, close, abort, send, runTurn } = await createRuntimeFixture(t);
      const failed = await runTurn("quota-model", "original request", failure.events);

      assert.equal(failed.stopReason, "error");
      assert.equal(failed.errorMessage, failure.error);
      assert.deepEqual(failed.content, failure.text ? [{ type: "text", text: failure.text }] : []);
      const failedRef = await bridge.runtimeSessionStore.get(sessionId, epoch);
      assert.equal(failedRef?.conversationId, "conversation-1");
      assert.equal(failedRef?.messageCount, 2);
      assert.ok(failedRef && messagesMatch(failedRef, manager.buildSessionContext().messages), "persist the failed assistant, not just the request");
      assert.equal(session.activeProcess, processes[0]);
      assert.ok(session.activeMcpServer);
      assert.equal(listeners.size, 0);
      assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), 2);
      assert.equal(close.mock.callCount(), 0);
      assert.equal(abort.mock.callCount(), 0);
      assert.equal(send.mock.callCount(), 1, "native errors do not automatically resend input");

      const recovered = await runTurn(row.model, "retry request", [
        { event: "step_update", delta: "Hello! How can I help you today?" }, row.result,
      ]);

      assert.equal(recovered.stopReason, "stop");
      assert.equal(recovered.errorMessage, undefined);
      assert.deepEqual(recovered.content, [{ type: "text", text: "Hello! How can I help you today?" }]);
      const recoveredProcess = processes.at(-1);
      assert.ok(recoveredProcess);
      assert.equal(session.activeProcess, recoveredProcess);
      assert.equal(processes.length, row.processes);
      assert.equal(recoveredProcess.options.model, row.model);
      assert.equal(recoveredProcess.options.conversationId, "conversation-1");
      const recoveredRef = await bridge.runtimeSessionStore.get(sessionId, epoch);
      assert.equal(recoveredRef?.conversationId, "conversation-1");
      assert.ok(recoveredRef && messagesMatch(recoveredRef, manager.buildSessionContext().messages));
      assert.equal(send.mock.callCount(), 2, "only the explicit retry adds input");
      assert.equal(send.mock.calls.at(-1)!.this, recoveredProcess);
      assert.equal(send.mock.calls.at(-1)!.arguments[0].message.content, "retry request");
      assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), 4);

      const continued = await runTurn(row.model, "continue request", [
        { event: "step_update", delta: "Continuing normally" }, { event: "result", status: "success" },
      ]);

      assert.equal(continued.stopReason, "stop");
      assert.equal(continued.errorMessage, undefined);
      assert.deepEqual(continued.content, [{ type: "text", text: "Continuing normally" }]);
      assert.equal(session.activeProcess, recoveredProcess);
      assert.equal(processes.length, row.processes);
      assert.equal(send.mock.callCount(), 3);
      assert.equal(send.mock.calls.at(-1)!.this, recoveredProcess);
      assert.equal(send.mock.calls.at(-1)!.arguments[0].message.content, "continue request");
      assert.deepEqual(manager.buildSessionContext().messages.filter((message) => message.role === "user").map((message) => message.content), [
        "original request", "retry request", "continue request",
      ]);
    });
  }
}

for (const failure of [modelErrors[0]!, modelErrors[1]!]) {
  test(`provider cold restart resumes saved conversation after ${failure.name}`, async (t) => {
    const { manager, sessionId, epoch, processes, send, runTurn, restartBridge } = await createRuntimeFixture(t);
    const failed = await runTurn("quota-model", "original request", failure.events);
    assert.equal(failed.stopReason, "error");
    const { bridge, session } = await restartBridge();
    assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), undefined);
    const saved = await bridge.runtimeSessionStore.get(sessionId, epoch);
    assert.equal(saved?.conversationId, "conversation-1");
    assert.ok(saved && messagesMatch(saved, manager.buildSessionContext().messages));

    const recovered = await runTurn("other-model", "new request", [{ event: "result", status: "success" }]);

    assert.equal(recovered.stopReason, "stop");
    assert.equal(processes.length, 2);
    assert.equal(session.activeProcess, processes[1]);
    assert.equal(processes[1]!.options.conversationId, "conversation-1");
    assert.equal(send.mock.calls.at(-1)!.arguments[0].message.content, "new request");
    assert.equal((await bridge.runtimeSessionStore.get(sessionId, epoch))?.conversationId, "conversation-1");
  });
}

const laterFailureCases: Array<{ name: string; response: AgyEvent[] | Error; source: AgyEventSource; text: string }> = [
  { name: "a synthetic runtime result after text output", response: [{ event: "step_update", delta: "Partial answer" }, { event: "result", status: "ERROR", error: "genuine failure" }], source: "runtime", text: "Partial answer" },
  { name: "a rejected send", response: new Error("genuine failure"), source: "agy", text: "" },
];

for (const row of laterFailureCases) {
  test(`provider reports and cleans up a genuine later failure: ${row.name}`, async (t) => {
    const { bridge, session, sessionId, epoch, processes, listeners, close, abort, send, runTurn } = await createRuntimeFixture(t);
    await runTurn("test-model", "successful request", [{ event: "result", status: "success" }]);
    const syncedCount = bridge.runtimeSessionSync.getSyncedMessageCount(session);
    assert.equal((await bridge.runtimeSessionStore.get(sessionId, epoch))?.conversationId, "conversation-1");

    const failed = await runTurn("test-model", "failed request", row.response, row.source);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(failed.stopReason, "error");
    assert.equal(failed.errorMessage, "genuine failure");
    assert.deepEqual(failed.content, row.text ? [{ type: "text", text: row.text }] : []);
    assert.equal(await bridge.runtimeSessionStore.get(sessionId, epoch), undefined);
    assert.equal(session.activeProcess, null);
    assert.equal(session.activeMcpServer, null);
    assert.equal(listeners.size, 0);
    assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), syncedCount);
    assert.equal(close.mock.callCount(), 1);
    assert.equal(abort.mock.calls[0]!.this, processes[0]);

    const retry = await runTurn("test-model", "retry request", [{ event: "result", status: "success" }]);
    assert.equal(retry.stopReason, "stop");
    assert.equal(processes.length, 2);
    assert.equal(processes[1]!.options.conversationId, undefined);
    const reconstructed = JSON.parse(send.mock.calls.at(-1)!.arguments[0].message.content);
    assert.equal(reconstructed.purpose, "reconstructed_conversation");
    assert.deepEqual(reconstructed.history.filter((message: { role: string }) => message.role === "user"), [
      { role: "user", content: "successful request" },
      { role: "user", content: "failed request" },
    ], "retry must include the original undelivered request");
    assert.deepEqual(reconstructed.history.at(-1), {
      role: "assistant", content: failed.content, stopReason: "error", errorMessage: "genuine failure",
    });
    assert.deepEqual(reconstructed.currentMessage, { role: "user", content: "retry request" });
  });
}

for (const source of ["agy", "runtime"] as const) {
  test(`late old ${source} callback cannot affect the replacement turn`, async (t) => {
    const { bridge, session, sessionId, epoch, processes, listeners, capturedListeners, send, runTurn } = await createRuntimeFixture(t);
    const setModel = t.mock.method(PiEventAdapter.prototype, "setModel");
    let oldSending!: () => void;
    let newSending!: () => void;
    const oldSent = new Promise<void>((resolve) => { oldSending = resolve; });
    const newSent = new Promise<void>((resolve) => { newSending = resolve; });
    send.mock.mockImplementation(async function (this: AgyRuntime, _input: AgyInput) {
      assert.ok(listeners.get(this));
      if (this.options.model === "old-model") oldSending();
      else newSending();
    });
    const oldTurn = runTurn("old-model", "old request", []);
    await oldSent;
    const oldAdapter = setModel.mock.calls[0]!.this as PiEventAdapter;
    t.after(async () => {
      oldAdapter.handleTermination("aborted", "test cleanup");
      await oldTurn;
    });
    const oldListener = capturedListeners.get(processes[0]!);
    assert.ok(oldListener);
    const nextTurn = runTurn("new-model", "new request", []);
    await newSent;
    const replacement = session.activeProcess;
    const replacementMcp = session.activeMcpServer;
    assert.ok(replacement);
    assert.notEqual(replacement, processes[0]);
    const replacementListener = listeners.get(replacement);
    assert.ok(replacementListener);
    t.after(() => replacementListener({ event: "result", status: "success" }, "agy"));
    const checkpoint = bridge.runtimeSessionSync.getSyncedMessageCount(session);

    oldListener({ event: "step_update", delta: "stale text" }, "agy");
    oldListener({ event: "result", status: "error", error: "late old failure" }, source);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(oldAdapter.isCompleted(), false, "old callback must be ignored before reaching its unfinished adapter");
    assert.deepEqual(oldAdapter.message.content, []);
    assert.equal(session.activeProcess, replacement);
    assert.equal(session.activeMcpServer, replacementMcp);
    assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), checkpoint);
    assert.equal((await bridge.runtimeSessionStore.get(sessionId, epoch))?.conversationId, "conversation-1");
    replacementListener({ event: "step_update", delta: "replacement answer" }, "agy");
    replacementListener({ event: "result", status: "success" }, "agy");
    const completed = await nextTurn;
    assert.equal(completed.stopReason, "stop");
    assert.equal(completed.errorMessage, undefined);
    assert.deepEqual(completed.content, [{ type: "text", text: "replacement answer" }]);
    assert.equal(session.activeProcess, replacement);
  });
}

for (const cleanupRejects of [false, true]) {
  test(`provider delayed failed-runtime cleanup cannot clear the replacement${cleanupRejects ? " even when cleanup fails" : ""}`, async (t) => {
    let releaseClose!: () => void;
    const closing = new Promise<void>((resolve) => { releaseClose = resolve; });
    t.after(() => releaseClose());
    const { bridge, session, sessionId, epoch, processes, close, abort, runTurn } = await createRuntimeFixture(t);
    let delayClose = true;
    close.mock.mockImplementation(async () => {
      if (!delayClose) return;
      delayClose = false;

      await closing;
      if (cleanupRejects) throw new Error("bridge cleanup failed");
    });
    abort.mock.mockImplementation(async function (this: AgyRuntime) {
      if (this === processes[0] && cleanupRejects) throw new Error("process cleanup failed");
    });

    await runTurn("test-model", "failed request", new Error("stdin write failed"));
    assert.equal(session.activeProcess, null);
    assert.equal(await bridge.runtimeSessionStore.get(sessionId, epoch), undefined);
    assert.equal(abort.mock.callCount(), 0, "old IPC cleanup is still pending");
    const recovered = await runTurn("test-model", "retry request", [{ event: "result", status: "success" }]);
    const replacement = processes.at(-1);
    assert.ok(replacement);
    assert.equal(session.activeProcess, replacement);
    assert.notEqual(replacement, processes[0]);

    releaseClose();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(recovered.stopReason, "stop");
    assert.equal(recovered.errorMessage, undefined);
    assert.equal(abort.mock.callCount(), 1);
    assert.equal(abort.mock.calls[0]!.this, processes[0]);
    assert.equal(session.activeProcess, replacement);
    assert.equal((await bridge.runtimeSessionStore.get(sessionId, epoch))?.conversationId, "conversation-2");
  });
}

const pendingGapCases: Array<{ name: string; event?: AgyEvent; source?: AgyEventSource; continues?: boolean }> = [
  { name: "native model error", event: { event: "result", status: "error", error: quotaError }, source: "agy" },
  { name: "synthetic runtime error", event: { event: "result", status: "error", error: "process exited in tool gap" }, source: "runtime" },
  { name: "blocked native tool", event: { event: "step_update", tool_call: { id: "native-call", name: "run_command", arguments: {} } }, source: "agy" },
  { name: "malformed native tool name object", event: JSON.parse('{"event":"step_update","tool_call":{"id":"native-call","name":{"toString":null},"arguments":{}}}'), source: "agy" },
  { name: "malformed native tool name array", event: JSON.parse('{"event":"step_update","tool_call":{"id":"native-call","name":[{"toString":null}],"arguments":{}}}'), source: "agy" },
  { name: "user abort" },
  { name: "matching Pi results", continues: true },
];

for (const row of pendingGapCases) {
  test(row.continues ? "provider replaces the safety subscription when Pi returns results" : `provider invalidates the actual post-toolUse gap after ${row.name}`, { timeout: 5000 }, async (t) => {
    const { bridge, manager, session, sessionId, epoch, processes, listeners, capturedListeners, close, abort, send, runTurn } = await createRuntimeFixture(t);
    const controller = new AbortController();
    const tools = [{ name: "test-tool", description: "test", parameters: { type: "object", properties: {} } }];
    const gateway = new CapabilityGateway(tools);
    t.after(() => gateway.cancelPendingCalls("test cleanup"));
    t.mock.method(bridge, "getTools", () => tools);
    let oldMcp: BridgeIPC | undefined;
    t.mock.getter(BridgeIPC.prototype, "hasPendingCalls", function (this: BridgeIPC) {
      return this === oldMcp && gateway.hasPendingCalls;
    });
    t.mock.method(BridgeIPC.prototype, "setToolCallHandler", function (this: BridgeIPC, handler: Parameters<BridgeIPC["setToolCallHandler"]>[0]) {
      if (!oldMcp && handler) oldMcp = this;
      if (this === oldMcp) gateway.setToolCallHandler(handler);
    });
    close.mock.mockImplementation(async function (this: BridgeIPC) {
      if (this === oldMcp) gateway.cancelPendingCalls("runtime disposed");
    });
    const resolve = t.mock.method(BridgeIPC.prototype, "resolveToolResults", (_results: Context["messages"], _appendix?: string): number => {
      throw new Error("must rebuild, not resume the incomplete MCP turn");
    });
    let toolSettled = false;
    send.mock.mockImplementation(async function (this: AgyRuntime, _input: AgyInput) {
      if (this === processes[0]) {
        void gateway.call("test-tool", { request: "original" }).then(() => { toolSettled = true; });
        return;
      }
      const listener = listeners.get(this);
      assert.ok(listener);
      listener({ event: "step_update", delta: "rebuilt answer" }, "agy");
      listener({ event: "result", status: "success" }, "agy");
    });

    const toolUse = await runTurn("test-model", "original request", [], "agy", controller.signal);
    assert.equal(toolUse.stopReason, "toolUse");
    const call = toolUse.content[0];
    assert.ok(call?.type === "toolCall");
    const oldProcess = processes[0]!;
    assert.equal(session.activeProcess, oldProcess);
    assert.equal(session.activeMcpServer, oldMcp);
    assert.equal(oldMcp?.hasPendingCalls, true);
    assert.equal(toolSettled, false, "Pi has not returned any results yet");
    const checkpoint = bridge.runtimeSessionSync.getSyncedMessageCount(session);
    assert.equal(checkpoint, 2);
    assert.equal((await bridge.runtimeSessionStore.get(sessionId, epoch))?.messageCount, checkpoint);

    if (row.continues) {
      const safetyListener = listeners.get(oldProcess);
      assert.ok(safetyListener, "keep a safety subscription until Pi returns results");
      manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name,
        content: [{ type: "text", text: "Pi result" }], isError: false, timestamp: Date.now() });
      resolve.mock.mockImplementation((results: Context["messages"], appendix?: string) => {
        const accepted = gateway.resolveToolResults(results, appendix);
        setImmediate(() => listeners.get(oldProcess)!({ event: "result", status: "success" }, "agy"));
        return accepted;
      });

      const continued = await runTurn("test-model", "continue request", []);
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(continued.stopReason, "stop");
      assert.notEqual(capturedListeners.get(oldProcess), safetyListener, "the next turn replaces, rather than stacks, the gap subscription");
      assert.equal(listeners.size, 0);
      assert.equal(resolve.mock.callCount(), 1);
      assert.equal(send.mock.callCount(), 1, "pending results resume MCP without another stdin turn");
      assert.equal(processes.length, 1);
      assert.equal(session.activeProcess, oldProcess);
      assert.equal(session.activeMcpServer, oldMcp);
      assert.equal(oldMcp?.hasPendingCalls, false);
      assert.equal(close.mock.callCount(), 0);
      assert.equal(abort.mock.callCount(), 0, "the preceding toolUse signal no longer owns the runtime");
      assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), 5);
      assert.equal((await bridge.runtimeSessionStore.get(sessionId, epoch))?.messageCount, 5);
      return;
    }

    if (row.event) listeners.get(oldProcess)?.(row.event, row.source!);
    else controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(session.activeProcess, null, "a completed toolUse stream still owns failure invalidation in the gap");
    assert.equal(session.activeMcpServer, null);
    assert.equal(await bridge.runtimeSessionStore.get(sessionId, epoch), undefined);
    assert.equal(listeners.size, 0);
    assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), checkpoint);
    assert.equal(toolUse.stopReason, "toolUse", "the already completed assistant is not rewritten");
    assert.equal(close.mock.callCount(), 1);
    assert.equal(abort.mock.calls[0]!.this, oldProcess);

    manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name,
      content: [{ type: "text", text: "late Pi result" }], isError: false, timestamp: Date.now() });
    const retry = await runTurn("test-model", "retry request", []);

    assert.equal(retry.stopReason, "stop");
    assert.deepEqual(retry.content, [{ type: "text", text: "rebuilt answer" }]);
    assert.equal(resolve.mock.callCount(), 0);
    assert.equal(processes.length, 2);
    assert.equal(processes[1]!.options.conversationId, undefined);
    assert.equal(session.activeProcess, processes[1]);
    const reconstructed = JSON.parse(send.mock.calls.at(-1)!.arguments[0].message.content);
    assert.equal(reconstructed.purpose, "reconstructed_conversation");
    assert.equal(reconstructed.history.at(-1).role, "toolResult");
    assert.deepEqual(reconstructed.currentMessage, { role: "user", content: "retry request" });
    assert.equal((await bridge.runtimeSessionStore.get(sessionId, epoch))?.conversationId, "conversation-2");
    assert.equal(listeners.size, 0);
  });
}

for (const terminal of ["success", "quota"] as const) {
  for (const oldAborted of [false, true]) {
    test(`delayed ${terminal} send rejection cannot dispose replacement with old signal aborted=${oldAborted}`, { timeout: 5000 }, async (t) => {
      const { bridge, session, sessionId, epoch, processes, listeners, close, abort, send, runTurn } = await createRuntimeFixture(t);
      const oldController = new AbortController();
      const setModel = t.mock.method(PiEventAdapter.prototype, "setModel");
      let rejectOld!: (error: Error) => void;
      const oldSend = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
      t.after(() => rejectOld(new Error("test cleanup")));
      let replacementSending!: () => void;
      const replacementSent = new Promise<void>((resolve) => { replacementSending = resolve; });
      send.mock.mockImplementation(async function (this: AgyRuntime, _input: AgyInput) {
        const listener = listeners.get(this);
        assert.ok(listener);
        if (this.options.model === "old-model") {
          listener(terminal === "quota"
            ? { event: "result", status: "error", error: quotaError }
            : { event: "result", status: "success" }, "agy");
          await oldSend;
        } else {
          replacementSending();
        }
      });

      const completedOld = await runTurn("old-model", "old request", [], "agy", oldController.signal);
      assert.equal(completedOld.stopReason, terminal === "quota" ? "error" : "stop");
      assert.equal(session.activeProcess, processes[0]);
      const replacementTurn = runTurn("new-model", "replacement request", []);
      t.after(async () => {
        const adapter = setModel.mock.calls[1]?.this as PiEventAdapter | undefined;
        adapter?.handleTermination("aborted", "test cleanup");
        await replacementTurn;
      });
      await replacementSent;
      const replacement = session.activeProcess;
      const replacementMcp = session.activeMcpServer;
      assert.ok(replacement);
      assert.notEqual(replacement, processes[0]);
      const checkpoint = bridge.runtimeSessionSync.getSyncedMessageCount(session);
      const reference = await bridge.runtimeSessionStore.get(sessionId, epoch);
      assert.equal(reference?.conversationId, "conversation-1");
      assert.equal(close.mock.callCount(), 1);
      assert.equal(abort.mock.callCount(), 1);

      if (oldAborted) oldController.abort();
      rejectOld(new Error("old stdin write rejected after terminal result"));
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(session.activeProcess, replacement);
      assert.equal(session.activeMcpServer, replacementMcp);
      assert.equal(close.mock.callCount(), 1);
      assert.equal(abort.mock.callCount(), 1);
      assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), checkpoint);
      assert.deepEqual(await bridge.runtimeSessionStore.get(sessionId, epoch), reference);
      const listener = listeners.get(replacement);
      assert.ok(listener, "stale catch must not unsubscribe the replacement");
      listener({ event: "step_update", delta: "replacement survives" }, "agy");
      listener({ event: "result", status: "success" }, "agy");
      const completed = await replacementTurn;
      assert.equal(completed.stopReason, "stop");
      assert.equal(completed.errorMessage, undefined);
      assert.deepEqual(completed.content, [{ type: "text", text: "replacement survives" }]);
      assert.equal(session.activeProcess, replacement);
      assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), 4);
    });
  }
}

for (const { terminal, aborted } of [
  { terminal: "success", aborted: false },
  { terminal: "success", aborted: true },
  { terminal: "quota", aborted: false },
  { terminal: "quota", aborted: true },
] as const) {
  test(`delayed send rejection invalidates owned native ${terminal} with signal aborted=${aborted}`, { timeout: 5000 }, async (t) => {
    const { bridge, session, sessionId, epoch, processes, listeners, close, abort, send, runTurn } = await createRuntimeFixture(t);
    const controller = new AbortController();
    let rejectSend!: (error: Error) => void;
    const pendingSend = new Promise<void>((_resolve, reject) => { rejectSend = reject; });
    t.after(() => rejectSend(new Error("test cleanup")));
    send.mock.mockImplementation(async function (this: AgyRuntime, _input: AgyInput) {
      const listener = listeners.get(this);
      assert.ok(listener);
      listener(terminal === "quota"
        ? { event: "result", status: "error", error: quotaError }
        : { event: "result", status: "success" }, "agy");
      await pendingSend;
    });

    const completed = await runTurn("test-model", "original request", [], "agy", controller.signal);
    assert.equal(completed.stopReason, terminal === "quota" ? "error" : "stop");
    assert.equal(completed.errorMessage, terminal === "quota" ? quotaError : undefined);
    assert.equal(session.activeProcess, processes[0]);
    assert.equal((await bridge.runtimeSessionStore.get(sessionId, epoch))?.messageCount, 2);
    const checkpoint = bridge.runtimeSessionSync.getSyncedMessageCount(session);

    if (aborted) controller.abort();
    assert.equal(session.activeProcess, processes[0], "completed turn no longer owns cancellation");
    rejectSend(new Error("stdin write failed after native result"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(session.activeProcess, null);
    assert.equal(session.activeMcpServer, null);
    assert.equal(await bridge.runtimeSessionStore.get(sessionId, epoch), undefined);
    assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), checkpoint);
    assert.equal(listeners.size, 0);
    assert.equal(close.mock.callCount(), 1);
    assert.equal(abort.mock.calls[0]!.this, processes[0]);
    assert.equal(completed.stopReason, terminal === "quota" ? "error" : "stop", "a recorded terminal result cannot hide a later transport failure");
    send.mock.mockImplementation(async function (this: AgyRuntime, _input: AgyInput) {
      listeners.get(this)!({ event: "result", status: "success" }, "agy");
    });
    const recovered = await runTurn("test-model", "retry request", []);
    assert.equal(recovered.stopReason, "stop");
    assert.equal(processes.length, 2);
    assert.equal(processes[1]!.options.conversationId, undefined);
    assert.equal(JSON.parse(send.mock.calls.at(-1)!.arguments[0].message.content).purpose, "reconstructed_conversation");
  });
}

for (const phase of ["before execution", "during runtime startup", "after history lookup"] as const) {
  test(`nonpending abort ${phase} preserves the saved conversation reference`, { timeout: 5000 }, async (t) => {
    const { bridge, session, sessionId, epoch, listeners, send, runTurn } = await createRuntimeFixture(t);
    const controller = new AbortController();
    if (phase === "after history lookup") await runTurn("test-model", "seed request", [{ event: "result", status: "success" }]);
    const reference = await bridge.runtimeSessionStore.get(sessionId, epoch);
    assert.equal(reference?.conversationId, "conversation-1");
    const start = t.mock.method(AgyRuntime.prototype, "start", async () => {
      controller.abort();
      controller.signal.throwIfAborted();
      throw new Error("startup must stop after abort");
    });
    const invalidate = t.mock.method(bridge.runtimeSessionStore, "delete", bridge.runtimeSessionStore.delete.bind(bridge.runtimeSessionStore));
    if (phase === "before execution") controller.abort();
    if (phase === "after history lookup") {
      const getReference = bridge.runtimeSessionStore.get.bind(bridge.runtimeSessionStore);
      t.mock.method(bridge.runtimeSessionStore, "get", async (...args: Parameters<typeof getReference>) => {
        const saved = await getReference(...args);
        queueMicrotask(() => controller.abort());
        return saved;
      });
    }

    const completed = await runTurn("test-model", "aborted request", [], "agy", controller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(completed.stopReason, "aborted");
    assert.equal(start.mock.callCount(), phase === "during runtime startup" ? 1 : 0);
    assert.equal(send.mock.callCount(), phase === "after history lookup" ? 1 : 0, "abort must not deliver another input");
    assert.equal(invalidate.mock.callCount(), 0);
    assert.deepEqual(await bridge.runtimeSessionStore.get(sessionId, epoch), reference);
    assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), phase === "before execution" ? undefined : reference?.messageCount,
      "startup may restore the saved checkpoint but must not append the aborted turn");
    assert.equal(session.activeProcess, null);
    assert.equal(session.activeMcpServer, null);
    assert.equal(listeners.size, 0);
  });
}

test("transport failure during deferred payload invalidates before delayed close and prevents delivery", { timeout: 5000 }, async (t) => {
  let resumePayload!: () => void;
  let releaseClose!: () => void;
  const payloadPending = new Promise<void>((resolve) => { resumePayload = resolve; });
  const closePending = new Promise<void>((resolve) => { releaseClose = resolve; });
  t.after(() => { resumePayload(); releaseClose(); });
  const { bridge, session, sessionId, epoch, listeners, close, abort, send, runTurn } = await createRuntimeFixture(t);
  let payloadEntered!: () => void;
  const payloadReady = new Promise<void>((resolve) => { payloadEntered = resolve; });
  close.mock.mockImplementation(async () => { await closePending; });
  const failedTurn = runTurn("test-model", "undelivered request", [], "agy", undefined, {
    onPayload: async () => {
      payloadEntered();
      await payloadPending;
      return { prompt: "must never be sent" };
    },
  });
  await payloadReady;
  const proc = session.activeProcess;
  const mcp = session.activeMcpServer;
  assert.ok(proc && mcp);
  assert.equal(send.mock.callCount(), 0);

  (mcp as unknown as { failTransport(error: Error): void }).failTransport(new Error("MCP disconnected during payload"));
  const failed = await failedTurn;

  assert.equal(failed.stopReason, "error");
  assert.equal(failed.errorMessage, "MCP disconnected during payload");
  assert.equal(await bridge.runtimeSessionStore.get(sessionId, epoch), undefined);
  assert.equal(session.activeProcess, null);
  assert.equal(session.activeMcpServer, null);
  assert.equal(listeners.size, 0);
  assert.equal(close.mock.callCount(), 1);
  assert.equal(abort.mock.callCount(), 0, "IPC close has not finished");

  resumePayload();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(send.mock.callCount(), 0, "resuming onPayload cannot deliver into an invalidated runtime");
  assert.equal(await bridge.runtimeSessionStore.get(sessionId, epoch), undefined);
  releaseClose();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(abort.mock.callCount(), 1);
  assert.equal(abort.mock.calls[0]!.this, proc);
});

for (const row of [
  { options: { reasoning: "max" }, error: "Unsupported Antigravity CLI reasoning effort: max. Supported values: low, medium, high." },
  { options: { thinkingLevel: "off" }, error: "Unsupported Antigravity CLI reasoning effort: off. Supported values: low, medium, high." },
]) {
  test(`unsupported effort on healthy runtime preserves saved conversation and PTY bindings: ${JSON.stringify(row.options)}`, { timeout: 5000 }, async (t) => {
    const { bridge, session, sessionId, epoch, listeners, close, abort, start, send, runTurn } = await createRuntimeFixture(t);
    await runTurn("test-model", "seed request", [{ event: "result", status: "success" }]);
    const reference = await bridge.runtimeSessionStore.get(sessionId, epoch);
    const proc = session.activeProcess;
    const mcp = session.activeMcpServer;
    const handle = session.resources.terminals.bind("healthy-pi-pty");
    const checkpoint = bridge.runtimeSessionSync.getSyncedMessageCount(session);
    const syncKey = session.syncKey;
    const invalidate = t.mock.method(bridge.runtimeSessionStore, "delete", bridge.runtimeSessionStore.delete.bind(bridge.runtimeSessionStore));
    const dispose = t.mock.method(session, "dispose", session.dispose.bind(session));
    const eventBinding = t.mock.method(session, "setRuntimeEventHandler", session.setRuntimeEventHandler.bind(session));
    const abortBinding = t.mock.method(session, "clearAbortSignal", session.clearAbortSignal.bind(session));

    const failed = await runTurn("test-model", "invalid effort request", [], "agy", undefined, row.options as SimpleStreamOptions);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(failed.stopReason, "error");
    assert.equal(failed.errorMessage, row.error);
    assert.equal(invalidate.mock.callCount(), 0);
    assert.equal(dispose.mock.callCount(), 0);
    assert.equal(eventBinding.mock.callCount(), 0);
    assert.equal(abortBinding.mock.callCount(), 0);
    assert.equal(start.mock.callCount(), 1);
    assert.equal(send.mock.callCount(), 1);
    assert.equal(close.mock.callCount(), 0);
    assert.equal(abort.mock.callCount(), 0);
    assert.deepEqual(await bridge.runtimeSessionStore.get(sessionId, epoch), reference);
    assert.equal(session.activeProcess, proc);
    assert.equal(session.activeMcpServer, mcp);
    assert.equal(session.conversationId, reference?.conversationId);
    assert.equal(session.syncKey, syncKey);
    assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), checkpoint);
    assert.equal(session.resources.terminals.resolve(handle), "healthy-pi-pty");
    assert.equal(session.resources.terminals.toHandle("healthy-pi-pty"), handle);
    assert.equal(listeners.size, 0);
  });
}

for (const { source, payloadSource } of [
  { source: "agy", payloadSource: "agy" },
  { source: "runtime", payloadSource: "agy" },
  { source: "agy", payloadSource: "runtime" },
  { source: "runtime", payloadSource: "runtime" },
] as const) {
  test(`callback ${source} controls identical quota result with payload source=${payloadSource}`, { timeout: 5000 }, async (t) => {
    const { bridge, manager, session, sessionId, epoch, processes, listeners, close, abort, runTurn } = await createRuntimeFixture(t);
    const raw = { event: "result", status: "error", error: quotaError, source: payloadSource } as const;

    const failed = await runTurn("test-model", "quota request", [raw], source);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(failed.stopReason, "error");
    assert.equal(failed.errorMessage, quotaError);
    assert.equal(listeners.size, 0);
    const reference = await bridge.runtimeSessionStore.get(sessionId, epoch);
    if (source === "agy") {
      assert.equal(session.activeProcess, processes[0]);
      assert.ok(session.activeMcpServer);
      assert.equal(reference?.conversationId, "conversation-1");
      assert.ok(reference && messagesMatch(reference, manager.buildSessionContext().messages));
      assert.equal(close.mock.callCount(), 0);
      assert.equal(abort.mock.callCount(), 0);
    } else {
      assert.equal(reference, undefined);
      assert.equal(session.activeProcess, null);
      assert.equal(session.activeMcpServer, null);
      assert.equal(close.mock.callCount(), 1);
      assert.equal(abort.mock.calls[0]!.this, processes[0]);
    }
  });
}

for (const outcome of ["failure", "cancellation", "delayed success"] as const) {
  test(`overlapping preparation ${outcome} cannot clear or overwrite newer runtime`, { timeout: 5000 }, async (t) => {
    let releaseOld!: () => void;
    const oldStartup = new Promise<void>((resolve) => { releaseOld = resolve; });
    t.after(() => releaseOld());
    const { bridge, session, sessionId, epoch, processes, listeners, close, abort, start, send, runTurn } = await createRuntimeFixture(t);
    const setModel = t.mock.method(PiEventAdapter.prototype, "setModel");
    let oldStarting!: () => void;
    let newSending!: () => void;
    const oldStarted = new Promise<void>((resolve) => { oldStarting = resolve; });
    const newSent = new Promise<void>((resolve) => { newSending = resolve; });
    const controller = new AbortController();
    start.mock.mockImplementation(async function (this: AgyRuntime) {
      processes.push(this);
      if (this.options.model === "old-model") {
        oldStarting();
        await oldStartup;
        if (outcome === "failure") throw new Error("superseded startup failed");
      }
      return { event: "init", conversation_id: this.options.conversationId ?? "new-conversation" } as Awaited<ReturnType<AgyRuntime["start"]>>;
    });
    send.mock.mockImplementation(async function (this: AgyRuntime, _input: AgyInput) {
      assert.ok(listeners.get(this));
      if (this.options.model === "new-model") newSending();
    });
    const invalidate = t.mock.method(bridge.runtimeSessionStore, "delete", bridge.runtimeSessionStore.delete.bind(bridge.runtimeSessionStore));
    const oldTurn = runTurn("old-model", "old request", [], "agy", controller.signal);
    await oldStarted;
    const newTurn = runTurn("new-model", "new request", []);
    t.after(async () => {
      releaseOld();
      for (const call of setModel.mock.calls) {
        (call.this as PiEventAdapter).handleTermination("aborted", "test cleanup");
      }
      await Promise.allSettled([oldTurn, newTurn]);
    });
    await newSent;
    const replacement = session.activeProcess;
    const replacementMcp = session.activeMcpServer;
    assert.equal(replacement, processes[1]);
    assert.ok(replacement && replacementMcp);
    const replacementListener = listeners.get(replacement);
    assert.ok(replacementListener);
    const handle = session.resources.terminals.bind("replacement-pi-pty");
    const reference = await bridge.runtimeSessionStore.get(sessionId, epoch);
    const checkpoint = bridge.runtimeSessionSync.getSyncedMessageCount(session);

    if (outcome === "cancellation") controller.abort();
    releaseOld();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(session.activeProcess, replacement, "a stale startup must not install over the current preparation");
    assert.equal(session.activeMcpServer, replacementMcp);
    assert.equal(listeners.get(replacement), replacementListener, "old catch must not unsubscribe the newer turn");
    assert.equal(invalidate.mock.callCount(), 0);
    assert.deepEqual(await bridge.runtimeSessionStore.get(sessionId, epoch), reference);
    assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), checkpoint);
    assert.equal(session.resources.terminals.resolve(handle), "replacement-pi-pty");
    assert.ok(close.mock.calls.every((call) => call.this !== replacementMcp));
    assert.ok(abort.mock.calls.every((call) => call.this !== replacement));
    assert.equal(processes.length, 2, "superseded resume failure cannot start a fallback runtime");
    assert.equal(send.mock.callCount(), 1, "only the newer preparation may deliver input");
    const superseded = await oldTurn;
    assert.ok(superseded.stopReason === "error" || superseded.stopReason === "aborted");

    replacementListener({ event: "step_update", delta: "new runtime survives" }, "agy");
    replacementListener({ event: "result", status: "success" }, "agy");
    const completed = await newTurn;
    assert.equal(completed.stopReason, "stop");
    assert.deepEqual(completed.content, [{ type: "text", text: "new runtime survives" }]);
    assert.equal(session.activeProcess, replacement);
  });
}
