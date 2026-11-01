import { useAuthHomeFixture } from "./auth-home-fixture.ts";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test, { describe, type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider, Model, Context, SimpleStreamOptions, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { AgyRuntime, type AgyEventSource } from "../runtime/process.ts";
import { BridgeIPC } from "../bridge/ipc.ts";
import { RuntimeSession as CliRuntimeSession } from "../drivers/cli/runtime.ts";
import { Driver as CliDriver } from "../drivers/cli/driver.ts";
import { createBridgeDriver } from "../drivers/driver.ts";
import type { DriverSession, PrepareDriverInput, RuntimeEvent } from "../drivers/types.ts";
import { parseModelsOutput } from "../discovery/models.ts";
import { prepareDriverCwd } from "../drivers/cwd.ts";
import { CapabilityGateway } from "../bridge/capabilities.ts";
import { PiRuntimeOutput } from "./output.ts";
import { RuntimeSessionSync, type AgyConversationCheckpoint } from "../session/state.ts";
import { LiveSession } from "../session/session.ts";
import type { AgyEvent, AgyInput } from "../shared/types.ts";
import { Bridge, streamProvider } from "./provider.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

useAuthHomeFixture();

function assertRestorableHistory(checkpoint: AgyConversationCheckpoint | undefined, messages: readonly unknown[]): void {
  assert.ok(checkpoint);
  assert.equal(checkpoint.messageCount, messages.length);
  const decision = new RuntimeSessionSync().decide(new LiveSession("checkpoint-verification"), {
    syncKey: "verification", messages, checkpoint,
  });
  assert.deepEqual(decision, { action: "resume", conversationId: checkpoint.sessionId });
}


async function createRuntimeFixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agy-provider-test-"));
  const originalGeminiHome = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = directory;
  t.after(() => {
    if (originalGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = originalGeminiHome;
  });
  let bridge: Bridge | undefined;
  const rawListeners = new Map<AgyRuntime, Parameters<AgyRuntime["onEvent"]>[0]>();
  const typedHandlers = new Set<Parameters<DriverSession["onRuntimeEvent"]>[0]>();
  t.after(async () => {
    try {
      await bridge?.liveSessions.disposeAll();
      assert.equal(rawListeners.size, 0, "disposed runtimes release raw subscriptions");
      assert.equal(typedHandlers.size, 0, "disposed sessions release typed handlers");
    } finally {
      t.mock.restoreAll();
      await rm(directory, { recursive: true, force: true });
    }
  });

  const agyPath = path.join(directory, "agy");
  t.mock.method(CliDriver.prototype, "detectExecutable", () => agyPath);
  await writeFile(agyPath, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.2.14; else exit 1; fi\n', { mode: 0o755 });
  const pi = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
  let runtimeBridge = new Bridge(pi, new CliDriver());
  bridge = runtimeBridge;
  const manager = SessionManager.inMemory("/workspace");
  const sessionId = runtimeBridge.piContextAdapter.bind(manager);
  const session = runtimeBridge.liveSessions.getOrCreate(sessionId);
  await runtimeBridge.runtimeSessionStore.set(sessionId, { sessionId: "conversation-1", compatibilityKey: createHash("sha256").update(prepareDriverCwd("cli")).digest("hex") }, [], runtimeBridge.driver.sessionVersion);

  t.mock.method(BridgeIPC.prototype, "start", async () => {});
  t.mock.getter(BridgeIPC.prototype, "bridgeUri", () => "unix:///synthetic.sock?session=test");
  t.mock.method(CliDriver.prototype, "installPlugin", async () => {});
  t.mock.getter(AgyRuntime.prototype, "isRunning", () => true);
  const close = t.mock.method(BridgeIPC.prototype, "close", async () => {});
  const abort = t.mock.method(AgyRuntime.prototype, "abort", async function (this: AgyRuntime) {
    rawListeners.delete(this);
  });
  const processes: AgyRuntime[] = [];
  const start = t.mock.method(AgyRuntime.prototype, "start", async function (this: AgyRuntime) {
    processes.push(this);
    return {
      event: "init", conversation_id: this.options.conversationId ?? `conversation-${processes.length}`,
    } as Awaited<ReturnType<AgyRuntime["start"]>>;
  });
  const capturedRawListeners = new Map<AgyRuntime, Parameters<AgyRuntime["onEvent"]>[0]>();
  t.mock.method(AgyRuntime.prototype, "onEvent", function (this: AgyRuntime, listener: Parameters<AgyRuntime["onEvent"]>[0]) {
    assert.equal(rawListeners.has(this), false, "a runtime owns only one event subscription");
    rawListeners.set(this, listener);
    capturedRawListeners.set(this, listener);
    return () => { rawListeners.delete(this); };
  });
  const capturedHandlers = new Map<AgyRuntime, Parameters<DriverSession["onRuntimeEvent"]>[0]>();
  const onRuntimeEvent = CliRuntimeSession.prototype.onRuntimeEvent;
  t.mock.method(CliRuntimeSession.prototype, "onRuntimeEvent", function (this: CliRuntimeSession, handler: Parameters<DriverSession["onRuntimeEvent"]>[0]) {
    typedHandlers.add(handler);
    capturedHandlers.set(this, handler);
    const unsubscribe = onRuntimeEvent.call(this, handler);
    return () => {
      typedHandlers.delete(handler);
      unsubscribe();
    };
  });
  let response: readonly AgyEvent[] | Error = [];
  let source: AgyEventSource = "agy";
  const send = t.mock.method(AgyRuntime.prototype, "send", async function (this: AgyRuntime, _input: AgyInput) {
    const listener = rawListeners.get(this);
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

    const message = await streamProvider(model, context, {
      sessionId, ...(signal ? { signal } : {}), ...options,
    }, runtimeBridge).result();

    manager.appendMessage(message);
    return message;
  };

  const restartBridge = async () => {
    await runtimeBridge.liveSessions.disposeAll();
    runtimeBridge = new Bridge(pi, new CliDriver());
    bridge = runtimeBridge;
    assert.equal(runtimeBridge.piContextAdapter.bind(manager), sessionId);
    return { bridge: runtimeBridge, session: runtimeBridge.liveSessions.getOrCreate(sessionId) };
  };

  return { bridge: runtimeBridge, manager, session, sessionId, processes, rawListeners, capturedRawListeners, typedHandlers, capturedHandlers, close, abort, start, send, runTurn, restartBridge };
}

const quotaError = "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h27m34s.";
const modelErrors: Array<{ name: string; events: AgyEvent[]; error: string; text: string }> = [
  { name: "quota", events: [{ event: "result", status: "error", error: quotaError }], error: quotaError, text: "" },
  { name: "arbitrary model error", events: [{ event: "result", status: "ERROR", error: { message: "Model could not answer" } }], error: "Model could not answer", text: "" },
  { name: "partial assistant text", events: [{ event: "step_update", delta: "Partial answer" }, { event: "result", status: "error", error: "Model could not finish" }], error: "Model could not finish", text: "Partial answer" },
  { name: "nested result", events: [{ event: "result", result: { status: "error", error: { message: quotaError } } }], error: quotaError, text: "" },
];
const recoveryCases = [
  { failure: modelErrors[0]!, name: "same-model retry", model: "quota-model", result: { event: "result", status: "success" }, processes: 1 },
  { failure: modelErrors[0]!, name: "switched-model retry", model: "other-model", result: { event: "result", status: "success" }, processes: 2 },
  { failure: modelErrors[0]!, name: "switched-model explicit success carrying stale quota", model: "other-model", result: { event: "result", status: "SUCCESS", error: quotaError }, processes: 2 },
  { failure: modelErrors[1]!, name: "same-model retry", model: "quota-model", result: { event: "result", status: "success" }, processes: 1 },
  { failure: modelErrors[2]!, name: "same-model retry", model: "quota-model", result: { event: "result", status: "success" }, processes: 1 },
  { failure: modelErrors[3]!, name: "same-model retry", model: "quota-model", result: { event: "result", status: "success" }, processes: 1 },
];

describe("runtime failure recovery", () => {
  for (const row of recoveryCases) {
    const { failure } = row;
    test(`provider retains conversation after ${failure.name}: ${row.name}`, async (t) => {
      const { bridge, manager, session, sessionId, processes, rawListeners, typedHandlers, close, abort, send, runTurn } = await createRuntimeFixture(t);
      const failed = await runTurn("quota-model", "original request", failure.events);

      assert.equal(failed.stopReason, "error");
      assert.equal(failed.errorMessage, failure.error);
      assert.deepEqual(failed.content, failure.text ? [{ type: "text", text: failure.text }] : []);
      const failedRef = await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion);
      assert.equal(failedRef?.sessionId, "conversation-1");
      assert.equal(failedRef?.messageCount, 2);
      assertRestorableHistory(failedRef, manager.buildSessionContext().messages);
      assert.equal(session.activeProcess, processes[0]);
      assert.ok(session.activeMcpServer);
      assert.equal(rawListeners.size, 1);
      assert.equal(typedHandlers.size, 0);
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
      const recoveredRef = await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion);
      assert.equal(recoveredRef?.sessionId, "conversation-1");
      assertRestorableHistory(recoveredRef, manager.buildSessionContext().messages);
      assert.equal(send.mock.callCount(), 2, "only the explicit retry adds input");
      assert.equal(send.mock.calls.at(-1)!.this, recoveredProcess);
      assert.equal(send.mock.calls.at(-1)!.arguments[0].message.content, "retry request");
      assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), 4);

      const recoveredListener = rawListeners.get(recoveredProcess);
      assert.ok(recoveredListener);
      assert.equal(rawListeners.size, 1);
      assert.equal(typedHandlers.size, 0);
      const continued = await runTurn(row.model, "continue request", [
        { event: "step_update", delta: "Continuing normally" }, { event: "result", status: "success" },
      ]);

      assert.equal(continued.stopReason, "stop");
      assert.equal(rawListeners.get(recoveredProcess), recoveredListener);
      assert.equal(rawListeners.size, 1);
      assert.equal(typedHandlers.size, 0);
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

  for (const row of [
    { name: "completed response", first: { update_type: "agent_response", state: "DONE" }, next: [], reason: "error" },
    { name: "turn error", first: { update_type: "error_message" }, next: [{ event: "step_update", update_type: "agent_response", state: "DONE" }], reason: "stop" },
  ] as const) {
    test(`reused translator clears ${row.name} state after a result`, async (t) => {
      const { processes, rawListeners, typedHandlers, runTurn } = await createRuntimeFixture(t);
      const failed = await runTurn("test-model", "first request", [
        { event: "step_update", ...row.first },
        { event: "result", status: "error", error: quotaError },
      ]);
      assert.equal(failed.stopReason, "error");
      const listener = rawListeners.get(processes[0]!);
      assert.ok(listener);

      const next = await runTurn("test-model", "next request", [
        ...row.next, { event: "result", status: "error", error: quotaError },
      ]);

      assert.equal(next.stopReason, row.reason);
      assert.equal(next.errorMessage, row.reason === "error" ? quotaError : undefined);
      assert.equal(processes.length, 1);
      assert.equal(rawListeners.get(processes[0]!), listener);
      assert.equal(typedHandlers.size, 0);
    });
  }

  for (const failure of [modelErrors[0]!, modelErrors[1]!]) {
    test(`provider cold restart resumes saved conversation after ${failure.name}`, async (t) => {
      const { manager, sessionId, processes, send, runTurn, restartBridge } = await createRuntimeFixture(t);
      const failed = await runTurn("quota-model", "original request", failure.events);
      assert.equal(failed.stopReason, "error");
      const { bridge, session } = await restartBridge();
      assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), undefined);
      const saved = await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion);
      assert.equal(saved?.sessionId, "conversation-1");
      assertRestorableHistory(saved, manager.buildSessionContext().messages);

      const recovered = await runTurn("other-model", "new request", [{ event: "result", status: "success" }]);

      assert.equal(recovered.stopReason, "stop");
      assert.equal(processes.length, 2);
      assert.equal(session.activeProcess, processes[1]);
      assert.equal(processes[1]!.options.conversationId, "conversation-1");
      assert.equal(send.mock.calls.at(-1)!.arguments[0].message.content, "new request");
      assert.equal((await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion))?.sessionId, "conversation-1");
    });
  }

});
describe("runtime failure invalidation and history reconstruction", () => {
  const laterFailureCases: Array<{ name: string; response: AgyEvent[] | Error; source: AgyEventSource; text: string }> = [
    { name: "a synthetic runtime result after text output", response: [{ event: "step_update", delta: "Partial answer" }, { event: "result", status: "ERROR", error: "genuine failure" }], source: "runtime", text: "Partial answer" },
    { name: "a rejected send", response: new Error("genuine failure"), source: "agy", text: "" },
  ];

  for (const row of laterFailureCases) {
    test(`provider reports and cleans up a genuine later failure: ${row.name}`, async (t) => {
      const { bridge, session, sessionId, processes, rawListeners, close, abort, send, runTurn } = await createRuntimeFixture(t);
      await runTurn("test-model", "successful request", [{ event: "result", status: "success" }]);
      const syncedCount = bridge.runtimeSessionSync.getSyncedMessageCount(session);
      assert.equal((await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion))?.sessionId, "conversation-1");

      const failed = await runTurn("test-model", "failed request", row.response, row.source);
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(failed.stopReason, "error");
      assert.equal(failed.errorMessage, "genuine failure");
      assert.deepEqual(failed.content, row.text ? [{ type: "text", text: row.text }] : []);
      assert.equal(await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion), undefined);
      assert.equal(session.activeProcess, null);
      assert.equal(session.activeMcpServer, null);
      assert.equal(rawListeners.size, 0);
      assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), syncedCount);
      assert.equal(close.mock.callCount(), 1);
      assert.equal(abort.mock.calls[0]!.this, processes[0]);

      const retry = await runTurn("test-model", "retry request", [{ event: "result", status: "success" }]);
      assert.equal(retry.stopReason, "stop");
      assert.equal(processes.length, 2);
      assert.equal(processes[1]!.options.conversationId, undefined);
      const reconstructed = send.mock.calls.at(-1)!.arguments[0].message.content;
      assert.ok(reconstructed.startsWith("[System]: Keep Pi history"));
      const successfulRequest = reconstructed.indexOf("[User]: successful request");
      const failedRequest = reconstructed.indexOf("[User]: failed request");
      assert.ok(successfulRequest >= 0);
      assert.ok(failedRequest > successfulRequest, "retry includes the original undelivered request in order");
      assert.ok(reconstructed.includes(row.text
        ? `[Assistant]: ${row.text}\n\nError: genuine failure`
        : "[Assistant]: Error: genuine failure"));
      assert.ok(reconstructed.endsWith("retry request"));
    });
  }

});
describe("runtime ownership and late callbacks", () => {
  for (const source of ["agy", "runtime"] as const) {
    test(`late old ${source} callback cannot affect the replacement turn`, async (t) => {
      const { bridge, session, sessionId, processes, rawListeners, capturedRawListeners, send, runTurn } = await createRuntimeFixture(t);
      const setModel = t.mock.method(PiRuntimeOutput.prototype, "setModel");
      let oldSending!: () => void;
      let newSending!: () => void;
      const oldSent = new Promise<void>((resolve) => { oldSending = resolve; });
      const newSent = new Promise<void>((resolve) => { newSending = resolve; });
      send.mock.mockImplementation(async function (this: AgyRuntime, _input: AgyInput) {
        assert.ok(rawListeners.get(this));
        if (this.options.model === "old-model") oldSending();
        else newSending();
      });
      const oldTurn = runTurn("old-model", "old request", []);
      await oldSent;
      const oldAdapter = setModel.mock.calls[0]!.this as PiRuntimeOutput;
      t.after(async () => {
        oldAdapter.handleTermination("aborted", "test cleanup");
        await oldTurn;
      });
      const oldListener = capturedRawListeners.get(processes[0]!);
      assert.ok(oldListener);
      const nextTurn = runTurn("new-model", "new request", []);
      await newSent;
      const replacement = session.activeProcess;
      const replacementMcp = session.activeMcpServer;
      assert.ok(replacement);
      assert.notEqual(replacement, processes[0]);
      assert.ok(replacement instanceof AgyRuntime);
      const replacementListener = rawListeners.get(replacement);
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
      assert.equal((await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion))?.sessionId, "conversation-1");
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
      const { bridge, session, sessionId, processes, rawListeners, close, abort, runTurn } = await createRuntimeFixture(t);
      let delayClose = true;
      close.mock.mockImplementation(async () => {
        if (!delayClose) return;
        delayClose = false;

        await closing;
        if (cleanupRejects) throw new Error("bridge cleanup failed");
      });
      abort.mock.mockImplementation(async function (this: AgyRuntime) {
        rawListeners.delete(this);
        if (this === processes[0] && cleanupRejects) throw new Error("process cleanup failed");
      });

      await runTurn("test-model", "failed request", new Error("stdin write failed"));
      assert.equal(session.activeProcess, null);
      assert.equal(await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion), undefined);
      assert.equal(abort.mock.callCount(), 0, "old IPC cleanup is still pending");
      const recovery = runTurn("test-model", "retry request", [{ event: "result", status: "success" }]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(processes.length, 1, "retry waits for old runtime cleanup");

      releaseClose();
      const recovered = await recovery;
      const replacement = processes.at(-1);
      assert.ok(replacement);
      assert.equal(session.activeProcess, replacement);
      assert.notEqual(replacement, processes[0]);

      assert.equal(recovered.stopReason, "stop");
      assert.equal(recovered.errorMessage, undefined);
      assert.equal(abort.mock.callCount(), 1);
      assert.equal(abort.mock.calls[0]!.this, processes[0]);
      assert.equal(session.activeProcess, replacement);
      assert.equal((await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion))?.sessionId, "conversation-2");
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
      const { bridge, manager, session, sessionId, processes, rawListeners, capturedRawListeners, typedHandlers, capturedHandlers, close, abort, send, runTurn } = await createRuntimeFixture(t);
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
          rawListeners.get(this)!({ event: "step_update", usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 30 } }, "agy");
          void gateway.call("test-tool", { request: "original" }).then(() => { toolSettled = true; });
          return;
        }
        const listener = rawListeners.get(this);
        assert.ok(listener);
        listener({ event: "step_update", delta: "rebuilt answer" }, "agy");
        listener({ event: "result", status: "success" }, "agy");
      });

      const toolUse = await runTurn("test-model", "original request", [], "agy", controller.signal);
      assert.equal(toolUse.stopReason, "toolUse");
      assert.equal(toolUse.usage.totalTokens, 150);
      assert.equal(toolUse.usage.input, 100);
      const call = toolUse.content[0];
      assert.ok(call?.type === "toolCall");
      const oldProcess = processes[0]!;
      assert.equal(session.activeProcess, oldProcess);
      assert.equal(session.activeMcpServer, oldMcp);
      assert.equal(oldMcp?.hasPendingCalls, true);
      assert.equal(toolSettled, false, "Pi has not returned any results yet");
      const checkpoint = bridge.runtimeSessionSync.getSyncedMessageCount(session);
      assert.equal(checkpoint, 2);
      assert.equal((await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion))?.messageCount, checkpoint);

      if (row.continues) {
        const safetyListener = rawListeners.get(oldProcess);
        const safetyHandler = capturedHandlers.get(oldProcess);
        assert.equal(typedHandlers.size, 1);
        assert.ok(safetyListener, "keep a safety subscription until Pi returns results");
        manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name,
          content: [{ type: "text", text: "Pi result" }], isError: false, timestamp: Date.now() });
        resolve.mock.mockImplementation((results: Context["messages"], appendix?: string) => {
          const accepted = gateway.resolveToolResults(results, appendix);
          setImmediate(() => rawListeners.get(oldProcess)!({ event: "result", status: "success" }, "agy"));
          return accepted;
        });

        const continued = await runTurn("test-model", "continue request", []);
        controller.abort();
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.equal(continued.stopReason, "stop");
        assert.deepEqual(continued.usage, {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        }, "a replacement typed handler replays active context without billing it twice");
        assert.equal(capturedRawListeners.get(oldProcess), safetyListener, "reuse keeps the permanent raw subscription");
        assert.notEqual(capturedHandlers.get(oldProcess), safetyHandler, "the next turn replaces the typed safety handler");
        assert.equal(typedHandlers.size, 0);
        assert.equal(rawListeners.size, 1);
        assert.equal(resolve.mock.callCount(), 1);
        assert.equal(send.mock.callCount(), 1, "pending results resume MCP without another stdin turn");
        assert.equal(processes.length, 1);
        assert.equal(session.activeProcess, oldProcess);
        assert.equal(session.activeMcpServer, oldMcp);
        assert.equal(oldMcp?.hasPendingCalls, false);
        assert.equal(close.mock.callCount(), 0);
        assert.equal(abort.mock.callCount(), 0, "the preceding toolUse signal no longer owns the runtime");
        assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), 5);
        assert.equal((await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion))?.messageCount, 5);
        return;
      }

      if (row.event) rawListeners.get(oldProcess)?.(row.event, row.source!);
      else controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(session.activeProcess, null, "a completed toolUse stream still owns failure invalidation in the gap");
      assert.equal(session.activeMcpServer, null);
      assert.equal(await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion), undefined);
      assert.equal(rawListeners.size, 0);
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
      const reconstructed = send.mock.calls.at(-1)!.arguments[0].message.content;
      assert.ok(reconstructed.startsWith("[System]: Keep Pi history"));
      assert.ok(reconstructed.includes("- test-tool"));
      assert.ok(reconstructed.endsWith("retry request"));
      assert.equal((await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion))?.sessionId, "conversation-2");
      assert.equal(rawListeners.size, 1);
    });
  }

  for (const terminal of ["success", "quota"] as const) {
    for (const oldAborted of [false, true]) {
      test(`delayed ${terminal} send rejection cannot dispose replacement with old signal aborted=${oldAborted}`, { timeout: 5000 }, async (t) => {
        const { bridge, session, sessionId, processes, rawListeners, close, abort, send, runTurn } = await createRuntimeFixture(t);
        const oldController = new AbortController();
        const setModel = t.mock.method(PiRuntimeOutput.prototype, "setModel");
        let rejectOld!: (error: Error) => void;
        const oldSend = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
        t.after(() => rejectOld(new Error("test cleanup")));
        let replacementSending!: () => void;
        const replacementSent = new Promise<void>((resolve) => { replacementSending = resolve; });
        send.mock.mockImplementation(async function (this: AgyRuntime, _input: AgyInput) {
          const listener = rawListeners.get(this);
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
          const adapter = setModel.mock.calls[1]?.this as PiRuntimeOutput | undefined;
          adapter?.handleTermination("aborted", "test cleanup");
          await replacementTurn;
        });
        await replacementSent;
        const replacement = session.activeProcess;
        const replacementMcp = session.activeMcpServer;
        assert.ok(replacement);
        assert.notEqual(replacement, processes[0]);
        const checkpoint = bridge.runtimeSessionSync.getSyncedMessageCount(session);
        const reference = await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion);
        assert.equal(reference?.sessionId, "conversation-1");
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
        assert.deepEqual(await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion), reference);
        const listener = rawListeners.get(replacement);
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
      const { bridge, session, sessionId, processes, rawListeners, close, abort, send, runTurn } = await createRuntimeFixture(t);
      const controller = new AbortController();
      let rejectSend!: (error: Error) => void;
      const pendingSend = new Promise<void>((_resolve, reject) => { rejectSend = reject; });
      t.after(() => rejectSend(new Error("test cleanup")));
      send.mock.mockImplementation(async function (this: AgyRuntime, _input: AgyInput) {
        const listener = rawListeners.get(this);
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
      assert.equal((await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion))?.messageCount, 2);
      const checkpoint = bridge.runtimeSessionSync.getSyncedMessageCount(session);

      if (aborted) controller.abort();
      assert.equal(session.activeProcess, processes[0], "completed turn no longer owns cancellation");
      rejectSend(new Error("stdin write failed after native result"));
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(session.activeProcess, null);
      assert.equal(session.activeMcpServer, null);
      assert.equal(await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion), undefined);
      assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), checkpoint);
      assert.equal(rawListeners.size, 0);
      assert.equal(close.mock.callCount(), 1);
      assert.equal(abort.mock.calls[0]!.this, processes[0]);
      assert.equal(completed.stopReason, terminal === "quota" ? "error" : "stop", "a recorded terminal result cannot hide a later transport failure");
      send.mock.mockImplementation(async function (this: AgyRuntime, _input: AgyInput) {
        rawListeners.get(this)!({ event: "result", status: "success" }, "agy");
      });
      const recovered = await runTurn("test-model", "retry request", []);
      assert.equal(recovered.stopReason, "stop");
      assert.equal(processes.length, 2);
      assert.equal(processes[1]!.options.conversationId, undefined);
      const expectedPattern = terminal === "quota"
        ? new RegExp(`^\\[System\\]: Keep Pi history\\n\\n\\[User\\]: original request\\n\\n\\[Assistant\\]: Error: ${quotaError.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n\\nretry request$`)
        : /^\[System\]: Keep Pi history\n\n\[User\]: original request\n\nretry request$/;
      assert.match(send.mock.calls.at(-1)!.arguments[0].message.content, expectedPattern);
    });
  }

});
describe("cancellation and input delivery guards", () => {
  for (const phase of ["before execution", "during runtime startup", "after history lookup"] as const) {
    test(`nonpending abort ${phase} preserves the saved conversation reference`, { timeout: 5000 }, async (t) => {
      const { bridge, session, sessionId, rawListeners, send, runTurn } = await createRuntimeFixture(t);
      const controller = new AbortController();
      if (phase === "after history lookup") await runTurn("test-model", "seed request", [{ event: "result", status: "success" }]);
      const reference = await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion);
      assert.equal(reference?.sessionId, "conversation-1");
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
      assert.deepEqual(await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion), reference);
      assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), phase === "before execution" ? undefined : reference?.messageCount,
        "startup may restore the saved checkpoint but must not append the aborted turn");
      assert.equal(session.activeProcess, null);
      assert.equal(session.activeMcpServer, null);
      assert.equal(rawListeners.size, 0);
    });
  }

  test("transport failure during deferred payload invalidates before delayed close and prevents delivery", { timeout: 5000 }, async (t) => {
    let resumePayload!: () => void;
    let releaseClose!: () => void;
    const payloadPending = new Promise<void>((resolve) => { resumePayload = resolve; });
    const closePending = new Promise<void>((resolve) => { releaseClose = resolve; });
    t.after(() => { resumePayload(); releaseClose(); });
    const { bridge, session, sessionId, rawListeners, close, abort, send, runTurn } = await createRuntimeFixture(t);
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
    assert.equal(await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion), undefined);
    assert.equal(session.activeProcess, null);
    assert.equal(session.activeMcpServer, null);
    assert.equal(rawListeners.size, 1, "raw subscription lives until abort after IPC close");
    assert.equal(close.mock.callCount(), 1);
    assert.equal(abort.mock.callCount(), 0, "IPC close has not finished");

    resumePayload();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(send.mock.callCount(), 0, "resuming onPayload cannot deliver into an invalidated runtime");
    assert.equal(await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion), undefined);
    releaseClose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(abort.mock.callCount(), 1);
    assert.equal(abort.mock.calls[0]!.this, proc);
    assert.equal(rawListeners.size, 0, "abort unregisters the raw subscription");
  });

  for (const row of [
    { options: { reasoning: "max" }, error: "Unsupported Antigravity CLI reasoning effort: max. Supported values: low, medium, high." },
  ]) {
    test(`unsupported effort on healthy runtime preserves saved conversation and PTY bindings: ${JSON.stringify(row.options)}`, { timeout: 5000 }, async (t) => {
      const { bridge, session, sessionId, rawListeners, close, abort, start, send, runTurn } = await createRuntimeFixture(t);
      await runTurn("test-model", "seed request", [{ event: "result", status: "success" }]);
      const reference = await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion);
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
      assert.deepEqual(await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion), reference);
      assert.equal(session.activeProcess, proc);
      assert.equal(session.activeMcpServer, mcp);
      assert.equal(session.conversationId, reference?.sessionId);
      assert.equal(session.syncKey, syncKey);
      assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), checkpoint);
      assert.equal(session.resources.terminals.resolve(handle), "healthy-pi-pty");
      assert.equal(session.resources.terminals.toHandle("healthy-pi-pty"), handle);
      assert.equal(rawListeners.size, 1);
    });
  }

});
describe("runtime event source authority", () => {
  for (const { source, payloadSource } of [
    { source: "runtime", payloadSource: "agy" },
    { source: "agy", payloadSource: "runtime" },
  ] as const) {
    test(`callback ${source} controls identical quota result with payload source=${payloadSource}`, { timeout: 5000 }, async (t) => {
      const { bridge, manager, session, sessionId, processes, rawListeners, close, abort, runTurn } = await createRuntimeFixture(t);
      const raw = { event: "result", status: "error", error: quotaError, source: payloadSource } as const;

      const failed = await runTurn("test-model", "quota request", [raw], source);
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(failed.stopReason, "error");
      assert.equal(failed.errorMessage, quotaError);
      assert.equal(rawListeners.size, source === "agy" ? 1 : 0);
      const reference = await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion);
      if (source === "agy") {
        assert.equal(session.activeProcess, processes[0]);
        assert.ok(session.activeMcpServer);
        assert.equal(reference?.sessionId, "conversation-1");
        assertRestorableHistory(reference, manager.buildSessionContext().messages);
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

});
describe("overlapping runtime preparation", () => {
  for (const outcome of ["failure", "cancellation", "delayed success"] as const) {
    test(`overlapping preparation ${outcome} cannot clear or overwrite newer runtime`, { timeout: 5000 }, async (t) => {
      let releaseOld!: () => void;
      const oldStartup = new Promise<void>((resolve) => { releaseOld = resolve; });
      t.after(() => releaseOld());
      const { bridge, session, sessionId, processes, rawListeners, close, abort, start, send, runTurn } = await createRuntimeFixture(t);
      const setModel = t.mock.method(PiRuntimeOutput.prototype, "setModel");
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
        assert.ok(rawListeners.get(this));
        if (this.options.model === "new-model") newSending();
      });
      const invalidate = t.mock.method(bridge.runtimeSessionStore, "delete", bridge.runtimeSessionStore.delete.bind(bridge.runtimeSessionStore));
      const oldTurn = runTurn("old-model", "old request", [], "agy", controller.signal);
      await oldStarted;
      const newTurn = runTurn("new-model", "new request", []);
      t.after(async () => {
        releaseOld();
        for (const call of setModel.mock.calls) {
          (call.this as PiRuntimeOutput).handleTermination("aborted", "test cleanup");
        }
        await Promise.allSettled([oldTurn, newTurn]);
      });
      await newSent;
      const replacement = session.activeProcess;
      const replacementMcp = session.activeMcpServer;
      assert.equal(replacement, processes[1]);
      assert.ok(replacement && replacementMcp);
      assert.ok(replacement instanceof AgyRuntime);
      const replacementListener = rawListeners.get(replacement);
      assert.ok(replacementListener);
      const handle = session.resources.terminals.bind("replacement-pi-pty");
      const reference = await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion);
      const checkpoint = bridge.runtimeSessionSync.getSyncedMessageCount(session);

      if (outcome === "cancellation") controller.abort();
      releaseOld();
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(session.activeProcess, replacement, "a stale startup must not install over the current preparation");
      assert.equal(session.activeMcpServer, replacementMcp);
      assert.equal(rawListeners.get(replacement), replacementListener, "old catch must not unsubscribe the newer turn");
      assert.equal(invalidate.mock.callCount(), 0);
      assert.deepEqual(await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion), reference);
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

});
describe("explicit conversation continuation", () => {
  for (const row of [
    { name: "unchanged completed history", rewrite: undefined, valid: true },
    { name: "payload rewrite", rewrite: "Continue with a summary.", valid: true },
    { name: "payload rewrite to empty", rewrite: "", valid: false },
    { name: "payload rewrite to whitespace", rewrite: " \n\t", valid: false },
  ]) {
    test(`provider explicitly continues ${row.name}`, async (t) => {
      const { bridge, manager, session, sessionId, processes, rawListeners, typedHandlers, send, runTurn } = await createRuntimeFixture(t);
      const first = await runTurn("test-model", "original request", [
        { event: "step_update", delta: "Done", usage: { input_tokens: 100, output_tokens: 20 } },
        { event: "result", status: "success" },
      ]);
      assert.equal(first.stopReason, "stop");
      assert.equal(first.usage.totalTokens, 120);
      assert.equal(rawListeners.size, 1, "completion retains the reusable raw subscription");
      assert.equal(typedHandlers.size, 0, "completion releases the typed turn handler");
      const messages = manager.buildSessionContext().messages.filter(
        (message): message is Context["messages"][number] =>
          message.role === "user" || message.role === "assistant" || message.role === "toolResult",
      );
      assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), messages.length);
      const model = { id: "test-model", provider: "agy" } as Model<any>;
      const continuation = "Continue from the current conversation state without repeating completed work.";
      send.mock.mockImplementation(async function (this: AgyRuntime, _input: AgyInput) {
        rawListeners.get(this)!({ event: "result", status: "success" }, "agy");
      });
      const observed: unknown[] = [];
      const result = await streamProvider(model, { systemPrompt: "Keep Pi history", tools: [], messages }, {
        sessionId,
        onPayload: (payload) => {
          observed.push(payload);
          return row.rewrite === undefined ? undefined : { prompt: row.rewrite };
        },
      }, bridge).result();

      assert.deepEqual(observed, [{ prompt: continuation }]);
      assert.equal(processes.length, 1, "reuse the completed conversation");
      assert.equal(result.stopReason, row.valid ? "stop" : "error");
      assert.equal(send.mock.callCount(), row.valid ? 2 : 1);
      if (row.valid) {
        assert.equal(result.usage.totalTokens, 0, "a completed prompt does not replay stale context into a new prompt");
        assert.equal(send.mock.calls[1]!.arguments[0].message.content, row.rewrite ?? continuation);
      } else {
        assert.match(result.errorMessage!, /prompt must be a non-empty string/);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(rawListeners.size, row.valid ? 1 : 0);
      assert.equal(session.activeProcess, row.valid ? processes[0] : null);
      assert.equal(typedHandlers.size, 0, "continuation completion also releases its typed handler");
    });
  }

});
describe("stream authentication gate", () => {
  for (const scenario of [
    { name: "legacy enabled", marker: "1", apiKey: undefined, enabled: true },
    { name: "missing credential", marker: undefined, apiKey: undefined, enabled: false },
    { name: "disabled marker", marker: "0", apiKey: undefined, enabled: false },
    { name: "historical OAuth setup marker", marker: undefined, apiKey: "agy-bridge:test-epoch", enabled: true },
    { name: "OAuth setup marker", marker: undefined, apiKey: "agy-bridge:enabled", enabled: true },
    { name: "invalid OAuth marker", marker: undefined, apiKey: "agy-bridge:", enabled: false },
  ]) {
    test(`stream gate with unknown auth status: ${scenario.name}`, async (t) => {
      let provider: Provider | undefined;
      const bridge = new Bridge({
        on: () => {}, registerCommand: () => {}, getActiveTools: () => [], getAllTools: () => [],
        registerProvider: (registered: Provider) => { provider = registered; },
      } as unknown as ExtensionAPI, new CliDriver());
      t.after(() => bridge.liveSessions.disposeAll());
      const directory = await mkdtemp(path.join(os.tmpdir(), "agy-stream-gate-"));
      const previousHome = process.env.GEMINI_HOME;
      process.env.GEMINI_HOME = directory;
      t.after(async () => {
        if (previousHome === undefined) delete process.env.GEMINI_HOME;
        else process.env.GEMINI_HOME = previousHome;
        await rm(directory, { recursive: true, force: true });
      });

      const lookup = t.mock.method(bridge.runtimeSessionStore, "get", async () => {
        throw new Error("Reached runtime using existing Antigravity CLI login");
      });
      bridge.start();
      assert.ok(provider);

      for (const stream of [provider.stream, provider.streamSimple]) {
        assert.ok(stream);
        const message = await stream({ id: "test", provider: "agy" } as Model<any>,
          normalizeContext({ messages: [], tools: [] }), {
            sessionId: "gate-test",
            env: scenario.marker === undefined ? {} : { AGY_BRIDGE_ENABLED: scenario.marker },
            ...(scenario.apiKey ? { apiKey: scenario.apiKey } : {}),
          }).result();

        assert.equal(message.stopReason, "error");
        assert.equal(message.errorMessage, scenario.enabled
          ? "Reached runtime using existing Antigravity CLI login"
          : "Antigravity CLI disabled in Pi");
      }
      assert.equal(lookup.mock.callCount(), scenario.enabled ? 2 : 0);
      if (scenario.enabled) {
        for (const call of lookup.mock.calls) assert.deepEqual(call.arguments, ["gate-test", bridge.driver.sessionVersion]);
      }
    });
  }

});
describe("runtime preparation inputs and session identity", () => {
  for (const row of [
    { name: "bound session workspace", cwd: "/workspace/project" },
    { name: "process directory before a session is bound", cwd: undefined },
  ]) {
    test(`runtime preparation does not receive the ${row.name}`, async (t) => {
      const driver = new CliDriver();
      const pi = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
      const bridge = new Bridge(pi, driver);
      t.after(() => bridge.liveSessions.disposeAll());
      const sessionId = row.cwd
        ? bridge.piContextAdapter.bind(SessionManager.inMemory(row.cwd))
        : "unbound-session";
      const preparation = t.mock.method(driver, "prepareSession", async (_input: Parameters<CliDriver["prepareSession"]>[0]) => {
        throw new Error("Stopped after input capture");
      });
      const model = { id: "test-model", provider: "agy" } as Model<any>;

      const result = await streamProvider(model, { messages: [], tools: [] }, { sessionId }, bridge).result();

      assert.equal(preparation.mock.callCount(), 1);
      assert.equal(Object.hasOwn(preparation.mock.calls[0]!.arguments[0], "cwd"), false);
      assert.equal(result.stopReason, "error");
      assert.equal(result.errorMessage, "Stopped after input capture");
    });
  }

  test("turn persists its captured session version rather than a later driver selection", async (t) => {
    const bridge = new Bridge({ getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI);
    t.after(() => bridge.liveSessions.disposeAll());
    const sessionId = bridge.piContextAdapter.bind(SessionManager.inMemory(os.tmpdir()));
    const live = bridge.liveSessions.getOrCreate(sessionId);
    const mcp = new BridgeIPC([], live.id, live.resources);
    const version = bridge.driver.sessionVersion;
    let emit!: (event: RuntimeEvent) => void;
    let markSubmitted!: () => void;
    const submitted = new Promise<void>((resolve) => { markSubmitted = resolve; });
    const proc: DriverSession = {
      driver: "acp", isRunning: true, compatibilityKey: "c".repeat(64),
      onRuntimeEvent: (handler) => { emit = handler; return () => {}; },
      serializeContextUpdate: () => "",
      submit: async ({ beforeInput }) => {
        assert.equal(beforeInput(), true);
        emit({ type: "start" });
        emit({ type: "session-reference", reference: "remote-A" });
        emit({ type: "text-delta", delta: "answer" });
        markSubmitted();
      },
      abort: async () => {},
    };
    t.mock.method(bridge.driver, "prepareSession", async ({ preparationId, model }: PrepareDriverInput) => {
      assert.equal(live.setSession(proc, "sync-key", mcp, "remote-A", preparationId), true);
      return { proc, mcpServer: mcp, reconstructContext: true, modelId: model.id };
    });
    const context: Context = { tools: [], messages: [{ role: "user", content: "question", timestamp: 1 }] };
    const model = parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)")[0]!;
    const stream = streamProvider(model, context, { sessionId }, bridge);
    const collecting = (async () => {
      const events: AssistantMessageEvent[] = [];
      for await (const event of stream) events.push(event);
      return events;
    })();
    await submitted;

    bridge.driver = createBridgeDriver("cli");
    emit({ type: "complete", reason: "stop", resumable: true });
    const events = await collecting;

    assert.equal(events.at(-1)?.type, "done");
    const saved = await bridge.runtimeSessionStore.get(sessionId, version);
    assert.equal(saved?.sessionId, "remote-A");
    assert.equal(saved?.version, version);
    assert.equal(saved?.compatibilityKey, proc.compatibilityKey);
    assert.equal(saved?.messageCount, 2);
    assert.equal(await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion), undefined);
  });


});
describe("runtime startup cleanup", () => {
  const runtimeStartCases = [
    { stage: "bridge.start", aborts: 0, cancelled: false },
    { stage: "plugin install", aborts: 0, cancelled: false },
    { stage: "proc.start", aborts: 1, cancelled: false },
    { stage: "proc.start", aborts: 2, cancelled: true },
  ] as const;

  for (const { stage, aborts, cancelled } of runtimeStartCases) {
    test(`streamProvider cleans up after ${stage} ${cancelled ? "cancellation" : "failure"}`, async (t) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "agy-runtime-start-"));
      const previousHome = process.env.GEMINI_HOME;
      process.env.GEMINI_HOME = directory;
      t.after(async () => {
        if (previousHome === undefined) delete process.env.GEMINI_HOME;
        else process.env.GEMINI_HOME = previousHome;
        await rm(directory, { recursive: true, force: true });
      });

      const agyPath = path.join(directory, "agy");
      await writeFile(agyPath, '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo 1.2.14\nelse\n  exit 1\nfi\n', { mode: 0o755 });

      const failure = new Error(`injected ${stage} failure`);
      const controller = new AbortController();
      const startBridge = t.mock.method(BridgeIPC.prototype, "start", async function (this: BridgeIPC) {
        (this as unknown as { socketPath: string }).socketPath = path.join(directory, "bridge.sock");
        if (stage === "bridge.start") throw failure;
      });
      const close = t.mock.method(BridgeIPC.prototype, "close", async () => {});
      const startProc = t.mock.method(AgyRuntime.prototype, "start", async () => {
        if (stage === "proc.start") {
          if (cancelled) controller.abort(failure);
          throw failure;
        }
        return { event: "init", conversation_id: "test-conversation" } as Awaited<ReturnType<AgyRuntime["start"]>>;
      });
      const abort = t.mock.method(AgyRuntime.prototype, "abort", AgyRuntime.prototype.abort);
      const install = t.mock.method(CliDriver.prototype, "installPlugin", async () => {
        if (stage === "plugin install") throw failure;
      });
      t.after(() => {
        startBridge.mock.restore();
        close.mock.restore();
        startProc.mock.restore();
        abort.mock.restore();
        install.mock.restore();
      });

      const pi = {
        on: () => {},
        registerProvider: () => {},
        registerCommand: () => {},
        getActiveTools: () => [],
        getAllTools: () => [],
      } as unknown as ExtensionAPI;
      t.mock.method(CliDriver.prototype, "detectExecutable", () => agyPath);
      const bridge = new Bridge(pi, new CliDriver());
      bridge.start();
      const context: Context = { messages: [], tools: [], systemPrompt: "" };
      const model = {
        id: "test-model", name: "Test model", api: "agy", provider: "agy",
        baseUrl: "agy", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192, maxTokens: 1024,
      } as Model<any>;
      const events: AssistantMessageEvent[] = [];
      for await (const event of streamProvider(model, context, { sessionId: `test-${stage}`, signal: controller.signal }, bridge)) {
        events.push(event);
        if (event.type === "error" || event.type === "done") break;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));

      const terminal = events.at(-1);
      assert.equal(terminal?.type, "error");
      if (terminal?.type === "error") {
        assert.equal(terminal.error.errorMessage, failure.message);
        assert.equal(terminal.error.stopReason, cancelled ? "aborted" : "error");
      }
      assert.equal(startBridge.mock.callCount(), 1);
      assert.equal(install.mock.callCount(), stage === "bridge.start" ? 0 : 1);
      assert.equal(startProc.mock.callCount(), aborts ? 1 : 0);
      assert.equal(close.mock.callCount(), cancelled ? 2 : 1, "cancelled startup must close IPC before ownership transfers");
      assert.equal(abort.mock.callCount(), aborts, "only a constructed runtime must be aborted");
    });
  }
});
