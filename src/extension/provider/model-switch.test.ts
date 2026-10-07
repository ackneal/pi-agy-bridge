import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BridgeIPC } from "../bridge/bridge-ipc.ts";
import { AgyRuntime } from "../runtime/process.ts";
import { calculateSyncKey } from "../session/session.ts";
import type { AgyEvent, AgyInput } from "../shared/types.ts";
import { AgyBridge, streamAgyProvider } from "./provider.ts";

const scenarios = [
  "Gemini to Claude", "live reference only", "foreign roundtrip", "foreign assistant without responseId", "branch checkpoint",
  "pending model switch", "resume rejects", "resume wait rejects", "resume mismatched init", "resume abort",
  "fallback fails", "active send fails",
] as const;

for (const scenario of scenarios) {
  test(`provider model switching: ${scenario}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-model-switch-"));
    const pi = {
      on: () => {}, registerProvider: () => {}, registerCommand: () => {},
      getActiveTools: () => [], getAllTools: () => [],
    } as unknown as ExtensionAPI;
    const config = { agyPath: path.join(directory, "agy"), pluginDir: directory, models: [] };
    const bridge = new AgyBridge(pi, config);
    t.after(async () => {
      try { await bridge.liveSessions.disposeAll(); }
      finally { t.mock.restoreAll(); await rm(directory, { recursive: true, force: true }); }
    });
    await writeFile(config.agyPath, '#!/bin/sh\necho 1.2.14\n', { mode: 0o755 });
    const manager = SessionManager.inMemory(directory);
    const sessionId = bridge.piContextAdapter.bind(manager);
    const session = bridge.liveSessions.getOrCreate(sessionId);
    const model = (id: string): Model<any> => ({
      id, name: id, api: "agy", provider: "agy", baseUrl: "agy", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
    } as Model<any>);
    const gemini = model("gemini");
    const claude = model("claude");
    const assistant: AssistantMessage = {
      role: "assistant", content: [{ type: "text", text: "previous answer" }], api: "agy", provider: "agy",
      model: gemini.id, responseId: "same-conversation", stopReason: "stop", timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const prefix: Context["messages"] = [{ role: "user", content: "original request", timestamp: 1 }, assistant];
    const oldProc = new AgyRuntime({ agentName: "pi-bridge", model: gemini.id });
    const oldMcp = new BridgeIPC([], session.id, session.resources);
    session.setSession(oldProc, calculateSyncKey("Rules", [], gemini.id, "", "pi-bridge"), oldMcp, "same-conversation");
    session.turnIndex = 1;
    const terminalHandle = session.resources.terminals.bind("pi-terminal");
    bridge.runtimeSessionSync.record(session, prefix);
    const expectedConversation = scenario === "branch checkpoint" ? "branch-conversation" : "same-conversation";
    if (scenario === "branch checkpoint") assistant.responseId = expectedConversation;
    if (scenario !== "live reference only") await bridge.runtimeSessionStore.set(sessionId, { conversationId: expectedConversation }, prefix);
    if (scenario === "foreign assistant without responseId") {
      const { responseId: _responseId, ...foreignAssistant } = assistant;
      prefix.push({ role: "user", content: "foreign question", timestamp: 3 }, {
        ...foreignAssistant, provider: "foreign", api: "foreign", model: "foreign",
        content: [{ type: "text", text: "foreign answer" }], timestamp: 4,
      });
    }
    let pending = scenario === "pending model switch";
    if (pending) {
      assistant.stopReason = "toolUse";
      assistant.content = [{ type: "toolCall", id: "pending-call", name: "test-tool", arguments: {} }];
      bridge.runtimeSessionSync.record(session, prefix);
      await bridge.runtimeSessionStore.set(sessionId, { conversationId: "same-conversation" }, prefix);
    }
    const context: Context = { systemPrompt: "Rules", tools: [], messages: [...prefix, pending
      ? { role: "toolResult", toolCallId: "pending-call", toolName: "test-tool", content: [{ type: "text", text: "tool answer" }], isError: false, timestamp: 5 }
      : { role: "user", content: "new request", timestamp: 5 }] };
    const controller = new AbortController();
    const listeners = new Map<AgyRuntime, (event: AgyEvent) => void>();
    const lifecycle: string[] = [];
    t.mock.getter(AgyRuntime.prototype, "isRunning", () => true);
    t.mock.getter(BridgeIPC.prototype, "hasPendingCalls", function (this: BridgeIPC) { return this === oldMcp && pending; });
    t.mock.getter(BridgeIPC.prototype, "processEnvironment", () => ({}));
    t.mock.method(AgyBridge.prototype, "ensureAgyPluginInstalled", async () => {});
    t.mock.method(BridgeIPC.prototype, "start", async () => {});
    t.mock.method(BridgeIPC.prototype, "close", async () => { lifecycle.push("close"); });
    t.mock.method(AgyRuntime.prototype, "abort", async () => { lifecycle.push("abort"); });
    let attempts = 0;
    const start = t.mock.method(AgyRuntime.prototype, "start", async function (this: AgyRuntime) {
      attempts++;
      lifecycle.push(`start:${this.options.conversationId ?? "fresh"}`);
      if (attempts === 1 && ["resume rejects", "resume abort", "fallback fails"].includes(scenario)) {
        if (scenario === "resume abort") controller.abort(new Error("startup aborted"));
        throw new Error("resume rejected");
      }
      if (attempts === 2 && scenario === "fallback fails") throw new Error("fresh rejected");
      return { event: "init", conversation_id: scenario === "resume mismatched init" || !this.options.conversationId
        ? "fresh-conversation" : this.options.conversationId } as Awaited<ReturnType<AgyRuntime["start"]>>;
    });
    const wait = t.mock.method(BridgeIPC.prototype, "waitForConnection", async () => {
      if (attempts === 1 && scenario === "resume wait rejects") throw new Error("connection rejected");
    });
    t.mock.method(AgyRuntime.prototype, "onEvent", function (this: AgyRuntime, listener: (event: AgyEvent) => void) {
      listeners.set(this, listener);
      return () => { listeners.delete(this); };
    });
    const finish = (proc: AgyRuntime) => {
      const listener = listeners.get(proc);
      assert.ok(listener, "subscribe before delivering runtime results");
      listener({ event: "step_update", delta: "finished" });
      listener({ event: "result", status: "success", conversation_id: proc === oldProc ? "same-conversation" : session.conversationId! });
    };
    const send = t.mock.method(AgyRuntime.prototype, "send", async function (this: AgyRuntime, _input: AgyInput) {
      if (scenario === "active send fails") throw new Error("active turn failed");
      finish(this);
    });
    const resolve = t.mock.method(BridgeIPC.prototype, "resolveToolResults", (results: Context["messages"]) => {
      assert.equal(results.length, 1);
      pending = false;
      setImmediate(() => finish(oldProc));
      return 1;
    });
    const run = async (selected: Model<any>) => {
      const events: AssistantMessageEvent[] = [];
      for await (const event of streamAgyProvider(selected, context, { sessionId, signal: controller.signal }, config, bridge)) events.push(event);
      await new Promise<void>((resolve) => setImmediate(resolve));
      return events.at(-1);
    };

    const terminal = await run(scenario === "foreign roundtrip" ? gemini : claude);
    if (["resume abort", "fallback fails", "active send fails"].includes(scenario)) {
      assert.ok(terminal?.type === "error");
      assert.equal(terminal.reason, scenario === "resume abort" ? "aborted" : "error");
      assert.equal(start.mock.callCount(), scenario === "fallback fails" ? 2 : 1);
      assert.equal(send.mock.callCount(), scenario === "active send fails" ? 1 : 0);
      assert.equal(session.activeProcess, null);
      if (scenario !== "resume abort") assert.equal(await bridge.runtimeSessionStore.get(sessionId), undefined);
      return;
    }
    assert.ok(terminal?.type === "done");
    assert.equal(terminal.message.model, scenario === "pending model switch" || scenario === "foreign roundtrip" ? gemini.id : claude.id);
    if (scenario === "pending model switch") {
      assert.equal(start.mock.callCount(), 0);
      assert.equal(send.mock.callCount(), 0);
      assert.equal(resolve.mock.callCount(), 1);
      assert.equal(session.activeProcess, oldProc);
      assert.equal(terminal.message.responseId, "same-conversation");
      context.messages.push(terminal.message, { role: "user", content: "next request", timestamp: 6 });
      const next = await run(claude);
      assert.ok(next?.type === "done");
      assert.equal(next.message.model, claude.id);
      assert.equal(next.message.responseId, "same-conversation");
      assert.equal(start.mock.callCount(), 1);
      assert.equal(send.mock.callCount(), 1);
      assert.equal(session.activeProcess?.options.model, claude.id);
      assert.equal(session.activeProcess?.options.conversationId, "same-conversation");
      assert.equal(session.resources.terminals.resolve(terminalHandle), "pi-terminal");
      assert.equal(send.mock.calls[0]!.arguments[0].message.content, "next request");
      return;
    }
    const fallback = ["resume rejects", "resume wait rejects", "resume mismatched init"].includes(scenario);
    const foreign = scenario === "foreign assistant without responseId";
    const roundtrip = scenario === "foreign roundtrip";
    assert.equal(start.mock.callCount(), roundtrip ? 0 : fallback ? 2 : 1);
    assert.equal(send.mock.callCount(), 1);
    assert.equal(wait.mock.callCount(), roundtrip ? 0 : scenario === "resume wait rejects" ? 2 : 1);
    assert.equal(session.activeProcess?.options.model, scenario === "foreign roundtrip" ? gemini.id : claude.id);
    assert.equal(session.activeProcess?.options.conversationId, roundtrip || fallback || foreign ? undefined : expectedConversation);
    assert.equal(session.resources.terminals.resolve(terminalHandle), fallback || foreign || scenario === "branch checkpoint" ? undefined : "pi-terminal");
    assert.equal(terminal.message.responseId, fallback || foreign ? "fresh-conversation" : expectedConversation);
    const prompt = send.mock.calls[0]!.arguments[0].message.content;
    if (fallback || foreign) {
      const reconstructed = JSON.parse(prompt);
      assert.equal(reconstructed.purpose, "reconstructed_conversation");
      assert.equal(reconstructed.history.length, prefix.length);
      assert.equal(reconstructed.currentMessage.content, "new request");
      if (foreign) assert.match(prompt, /foreign answer/);
    } else assert.equal(prompt, "new request");
    if (fallback) assert.deepEqual(lifecycle.slice(0, 6), ["close", "abort", "start:same-conversation", "close", "abort", "start:fresh"]);
    assert.equal((await bridge.runtimeSessionStore.get(sessionId))?.conversationId, terminal.message.responseId);
    assert.equal(listeners.size, 0);
  });
}
