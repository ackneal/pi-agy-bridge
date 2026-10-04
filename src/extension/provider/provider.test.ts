import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider, Model, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { AgyRuntime } from "../runtime/process.ts";
import { BridgeIPC } from "../bridge/bridge-ipc.ts";
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

for (const modelId of ["claude-sonnet-4-6", "claude-opus-4-6-thinking"]) {
  for (const option of ["reasoningEffort", "reasoning", "thinkingLevel"]) {
    for (const effort of ["low", "medium", "high"]) {
      test(`rejects fixed ${modelId} ${option}=${effort} before runtime preparation`, async (t) => {
        const bridge = new AgyBridge({} as ExtensionAPI);
        const runtimeLookup = t.mock.method(bridge.runtimeSessionStore, "get", async () => {
          throw new Error("Runtime preparation must not begin");
        });
        const model = { id: modelId, provider: "agy", thinkingLevelMap: allNullThinkingLevels } as Model<any>;
        const stream = streamAgyProvider(model, { messages: [], tools: [] }, {
          sessionId: "validation-test", [option]: effort,
        }, undefined, bridge);
        const message = await stream.result();

        assert.equal(message.stopReason, "error");
        assert.equal(message.errorMessage, `Unsupported Antigravity CLI reasoning effort for ${modelId}: ${effort}.`);
        assert.equal(runtimeLookup.mock.callCount(), 0);
      });
    }
  }
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
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  const handlers = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  let provider: Provider | undefined;

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

  const shutdown = handlers.get("session_shutdown") as (() => Promise<void>);
  await shutdown();
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
  const runtimeBridge = new AgyBridge(pi, config);
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
  t.mock.method(AgyRuntime.prototype, "start", async function (this: AgyRuntime) {
    processes.push(this);
    return {
      event: "init", conversation_id: this.options.conversationId ?? `conversation-${processes.length}`,
    } as Awaited<ReturnType<AgyRuntime["start"]>>;
  });
  const listeners = new Map<AgyRuntime, (event: AgyEvent) => void>();
  t.mock.method(AgyRuntime.prototype, "onEvent", function (this: AgyRuntime, listener: (event: AgyEvent) => void) {
    listeners.set(this, listener);
    return () => { listeners.delete(this); };
  });
  let response: readonly AgyEvent[] | Error = [];
  const send = t.mock.method(AgyRuntime.prototype, "send", async function (this: AgyRuntime, _input: AgyInput) {
    const listener = listeners.get(this);
    assert.ok(listener, "subscribe before sending a turn");
    if (response instanceof Error) throw response;
    for (const event of response) listener(event);
  });

  const runTurn = async (modelId: string, request: string, events: readonly AgyEvent[] | Error) => {
    response = events;
    manager.appendMessage({ role: "user", content: request, timestamp: Date.now() });
    const messages = manager.buildSessionContext().messages;
    assert.ok(messages.every((message) => message.role === "user" || message.role === "assistant"));
    const context: Context = { systemPrompt: "Keep Pi history", tools: [], messages };
    const model = {
      id: modelId, name: modelId, api: "agy", provider: "agy", baseUrl: "agy", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
    } as Model<any>;

    const message = await streamAgyProvider(model, context, {
      sessionId, env: { AGY_BRIDGE_LOGIN_EPOCH: epoch },
    }, config, runtimeBridge).result();

    manager.appendMessage(message);
    return message;
  };

  return { bridge: runtimeBridge, manager, session, sessionId, epoch, processes, listeners, close, abort, send, runTurn };
}

const quotaError = "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h27m34s.";
const recoveryCases = [
  { name: "same-model retry", model: "quota-model", result: { event: "result", status: "success" } },
  { name: "switched-model retry", model: "other-model", result: { event: "result", status: "success" } },
  { name: "switched-model success carrying the previous quota error", model: "other-model", result: { event: "result", status: "SUCCESS", error: quotaError } },
];

for (const row of recoveryCases) {
  test(`provider rebuilds failed runtime and preserves history and continuity: ${row.name}`, async (t) => {
    const fixture = await createRuntimeFixture(t);
    const { bridge, manager, session, sessionId, epoch, processes, listeners, send, runTurn } = fixture;

    const failed = await runTurn("quota-model", "original request", [{ event: "result", status: "error", error: quotaError }]);

    assert.equal(failed.stopReason, "error");
    assert.equal(failed.errorMessage, quotaError);
    assert.equal(await bridge.runtimeSessionStore.get(sessionId, epoch), undefined);
    assert.equal(session.activeProcess, null);
    assert.equal(session.activeMcpServer, null);
    assert.equal(listeners.size, 0);
    assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), 0);

    const recovered = await runTurn(row.model, "retry request", [
      { event: "step_update", delta: "Hello! How can I help you today?" }, row.result,
    ]);

    assert.equal(recovered.stopReason, "stop");
    assert.equal(recovered.errorMessage, undefined);
    assert.deepEqual(recovered.content, [{ type: "text", text: "Hello! How can I help you today?" }]);
    const recoveredProcess = processes.at(-1);
    assert.ok(recoveredProcess);
    assert.equal(session.activeProcess, recoveredProcess);
    assert.notEqual(recoveredProcess, processes[0]);
    assert.equal(recoveredProcess.options.model, row.model);
    assert.equal(recoveredProcess.options.conversationId, undefined);
    assert.equal((await bridge.runtimeSessionStore.get(sessionId, epoch))?.conversationId, "conversation-2");
    const prompt = send.mock.calls.at(-1)!.arguments[0].message.content;
    assert.match(prompt, /purpose="reconstructed_conversation"/);
    for (const text of ["original request", "retry request", quotaError]) assert.ok(prompt.includes(text));

    const continued = await runTurn(row.model, "continue request", [
      { event: "step_update", delta: "Continuing normally" }, { event: "result", status: "success" },
    ]);

    assert.equal(continued.stopReason, "stop");
    assert.equal(continued.errorMessage, undefined);
    assert.deepEqual(continued.content, [{ type: "text", text: "Continuing normally" }]);
    assert.equal(session.activeProcess, recoveredProcess);
    assert.equal(processes.length, 2);
    assert.equal(send.mock.calls.at(-1)!.this, recoveredProcess);
    assert.equal(send.mock.calls.at(-1)!.arguments[0].message.content, "continue request");
    assert.deepEqual(manager.buildSessionContext().messages.filter((message) => message.role === "user").map((message) => message.content), [
      "original request", "retry request", "continue request",
    ]);
  });
}

const laterFailureCases: Array<{ name: string; response: AgyEvent[] | Error }> = [
  { name: "an error result after text output", response: [{ event: "step_update", delta: "Partial answer" }, { event: "result", status: "ERROR", error: "genuine failure" }] },
  { name: "a rejected send", response: new Error("genuine failure") },
];

for (const row of laterFailureCases) {
  test(`provider reports and cleans up a genuine later failure: ${row.name}`, async (t) => {
    const { bridge, session, sessionId, epoch, processes, listeners, close, abort, runTurn } = await createRuntimeFixture(t);
    await runTurn("test-model", "successful request", [{ event: "result", status: "success" }]);
    const syncedCount = bridge.runtimeSessionSync.getSyncedMessageCount(session);
    assert.equal((await bridge.runtimeSessionStore.get(sessionId, epoch))?.conversationId, "conversation-1");

    const failed = await runTurn("test-model", "failed request", row.response);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(failed.stopReason, "error");
    assert.equal(failed.errorMessage, "genuine failure");
    if (Array.isArray(row.response)) assert.deepEqual(failed.content, [{ type: "text", text: "Partial answer" }]);
    assert.equal(await bridge.runtimeSessionStore.get(sessionId, epoch), undefined);
    assert.equal(session.activeProcess, null);
    assert.equal(session.activeMcpServer, null);
    assert.equal(listeners.size, 0);
    assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), syncedCount);
    assert.equal(close.mock.callCount(), 1);
    assert.equal(abort.mock.calls[0]!.this, processes[0]);
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

    await runTurn("test-model", "failed request", [{ event: "result", status: "error", error: quotaError }]);
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
