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
import type { AgyInput } from "../shared/types.ts";
import { AgyBridge, streamAgyProvider } from "./provider.ts";

type ModelSwitchCase = {
  name: string;
  arrange: {
    persisted: boolean;
    conversationId: string;
    foreignHistory: boolean;
    pending: boolean;
    selectedModel: "gemini" | "claude";
    outcome: "success" | "reject" | "waitReject" | "dead" | "mismatch" | "abort" | "fallbackReject" | "sendReject";
    priorError?: string;
    omitPriorError?: boolean;
  };
  expected: {
    terminal: "error" | "aborted";
    starts: number;
    sends: number;
    waits: number;
    store: "retained" | "deleted";
  } | {
    terminal: "done";
    starts: number;
    sends: number;
    waits: number;
    model: "gemini" | "claude";
    runtimeConversation: string | undefined;
    responseId: string;
    preservesTerminal: boolean;
    continuation: { kind: "pending" } | { kind: "prompt"; reconstructed: boolean; fallback: boolean };
  };
};

const cases: ModelSwitchCase[] = [
  {
    name: "Gemini to Claude",
    arrange: {
      persisted: true, conversationId: "same-conversation", foreignHistory: false,
      pending: false, selectedModel: "claude", outcome: "success",
    },
    expected: {
      terminal: "done", starts: 1, sends: 1, waits: 1,
      model: "claude", runtimeConversation: "same-conversation",
      responseId: "same-conversation", preservesTerminal: true,
      continuation: { kind: "prompt", reconstructed: false, fallback: false },
    },
  },
  {
    name: "live reference only",
    arrange: {
      persisted: false, conversationId: "same-conversation", foreignHistory: false,
      pending: false, selectedModel: "claude", outcome: "success",
    },
    expected: {
      terminal: "done", starts: 1, sends: 1, waits: 1,
      model: "claude", runtimeConversation: "same-conversation",
      responseId: "same-conversation", preservesTerminal: true,
      continuation: { kind: "prompt", reconstructed: false, fallback: false },
    },
  },
  {
    name: "foreign roundtrip",
    arrange: {
      persisted: true, conversationId: "same-conversation", foreignHistory: false,
      pending: false, selectedModel: "gemini", outcome: "success",
    },
    expected: {
      terminal: "done", starts: 0, sends: 1, waits: 0,
      model: "gemini", runtimeConversation: undefined,
      responseId: "same-conversation", preservesTerminal: true,
      continuation: { kind: "prompt", reconstructed: false, fallback: false },
    },
  },
  {
    name: "foreign assistant without responseId",
    arrange: {
      persisted: true, conversationId: "same-conversation", foreignHistory: true,
      pending: false, selectedModel: "claude", outcome: "success",
    },
    expected: {
      terminal: "done", starts: 1, sends: 1, waits: 1,
      model: "claude", runtimeConversation: undefined,
      responseId: "fresh-conversation", preservesTerminal: false,
      continuation: { kind: "prompt", reconstructed: true, fallback: false },
    },
  },
  {
    name: "branch checkpoint",
    arrange: {
      persisted: true, conversationId: "branch-conversation", foreignHistory: false,
      pending: false, selectedModel: "claude", outcome: "success",
    },
    expected: {
      terminal: "done", starts: 1, sends: 1, waits: 1,
      model: "claude", runtimeConversation: "branch-conversation",
      responseId: "branch-conversation", preservesTerminal: false,
      continuation: { kind: "prompt", reconstructed: false, fallback: false },
    },
  },
  {
    name: "pending model switch",
    arrange: {
      persisted: true, conversationId: "same-conversation", foreignHistory: false,
      pending: true, selectedModel: "claude", outcome: "success",
    },
    expected: {
      terminal: "done", starts: 0, sends: 0, waits: 0,
      model: "gemini", runtimeConversation: undefined,
      responseId: "same-conversation", preservesTerminal: true,
      continuation: { kind: "pending" },
    },
  },
  {
    name: "resume rejects",
    arrange: {
      persisted: true, conversationId: "same-conversation", foreignHistory: false,
      pending: false, selectedModel: "claude", outcome: "reject",
    },
    expected: {
      terminal: "done", starts: 2, sends: 1, waits: 1,
      model: "claude", runtimeConversation: undefined,
      responseId: "fresh-conversation", preservesTerminal: false,
      continuation: { kind: "prompt", reconstructed: true, fallback: true },
    },
  },
  {
    name: "after-quota resume rejects and reconstructs failed history once",
    arrange: {
      persisted: true, conversationId: "same-conversation", foreignHistory: false,
      pending: false, selectedModel: "claude", outcome: "reject",
      priorError: "Individual quota reached. Resets in 3h27m34s.",
    },
    expected: {
      terminal: "done", starts: 2, sends: 1, waits: 1,
      model: "claude", runtimeConversation: undefined,
      responseId: "fresh-conversation", preservesTerminal: false,
      continuation: { kind: "prompt", reconstructed: true, fallback: true },
    },
  },
  {
    name: "Pi recovery projection removes the failed assistant",
    arrange: {
      persisted: true, conversationId: "same-conversation", foreignHistory: false,
      pending: false, selectedModel: "claude", outcome: "success",
      priorError: "Rate limit exceeded", omitPriorError: true,
    },
    expected: {
      terminal: "done", starts: 1, sends: 1, waits: 1,
      model: "claude", runtimeConversation: undefined,
      responseId: "fresh-conversation", preservesTerminal: false,
      continuation: { kind: "prompt", reconstructed: true, fallback: false },
    },
  },
  {
    name: "resume wait rejects",
    arrange: {
      persisted: true, conversationId: "same-conversation", foreignHistory: false,
      pending: false, selectedModel: "claude", outcome: "waitReject",
    },
    expected: {
      terminal: "done", starts: 2, sends: 1, waits: 2,
      model: "claude", runtimeConversation: undefined,
      responseId: "fresh-conversation", preservesTerminal: false,
      continuation: { kind: "prompt", reconstructed: true, fallback: true },
    },
  },
  {
    name: "resume exits between init and MCP connection",
    arrange: {
      persisted: true, conversationId: "same-conversation", foreignHistory: false,
      pending: false, selectedModel: "claude", outcome: "dead",
    },
    expected: {
      terminal: "done", starts: 2, sends: 1, waits: 2,
      model: "claude", runtimeConversation: undefined,
      responseId: "fresh-conversation", preservesTerminal: false,
      continuation: { kind: "prompt", reconstructed: true, fallback: true },
    },
  },
  {
    name: "resume mismatched init",
    arrange: {
      persisted: true, conversationId: "same-conversation", foreignHistory: false,
      pending: false, selectedModel: "claude", outcome: "mismatch",
    },
    expected: {
      terminal: "done", starts: 2, sends: 1, waits: 1,
      model: "claude", runtimeConversation: undefined,
      responseId: "fresh-conversation", preservesTerminal: false,
      continuation: { kind: "prompt", reconstructed: true, fallback: true },
    },
  },
  {
    name: "resume abort",
    arrange: {
      persisted: true, conversationId: "same-conversation", foreignHistory: false,
      pending: false, selectedModel: "claude", outcome: "abort",
    },
    expected: {
      terminal: "aborted", starts: 1, sends: 0, waits: 0,
      store: "retained",
    },
  },
  {
    name: "fallback fails",
    arrange: {
      persisted: true, conversationId: "same-conversation", foreignHistory: false,
      pending: false, selectedModel: "claude", outcome: "fallbackReject",
    },
    expected: {
      terminal: "error", starts: 2, sends: 0, waits: 0,
      store: "deleted",
    },
  },
  {
    name: "active send fails",
    arrange: {
      persisted: true, conversationId: "same-conversation", foreignHistory: false,
      pending: false, selectedModel: "claude", outcome: "sendReject",
    },
    expected: {
      terminal: "error", starts: 1, sends: 1, waits: 1,
      store: "deleted",
    },
  },
];

for (const { name, arrange, expected } of cases) {
  test(`provider model switching: ${name}`, async (t) => {
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
    const selected = model(arrange.selectedModel);
    const assistant: AssistantMessage = {
      role: "assistant", content: [{ type: "text", text: "previous answer" }], api: "agy", provider: "agy",
      model: gemini.id, responseId: "same-conversation", stopReason: arrange.priorError ? "error" : "stop", timestamp: 2,
      ...(arrange.priorError ? { errorMessage: arrange.priorError } : {}),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const prefix: Context["messages"] = [{ role: "user", content: "original request", timestamp: 1 }, assistant];
    const oldProc = new AgyRuntime({ agentName: "pi-bridge", model: gemini.id });
    const oldMcp = new BridgeIPC([], session.id, session.resources);
    session.setSession(oldProc, calculateSyncKey("Rules", [], gemini.id, "", "pi-bridge"), oldMcp, "same-conversation");
    const terminalHandle = session.resources.terminals.bind("pi-terminal");
    bridge.runtimeSessionSync.record(session, prefix);
    assistant.responseId = arrange.conversationId;
    if (arrange.persisted) await bridge.runtimeSessionStore.set(sessionId, { conversationId: arrange.conversationId }, prefix);
    if (arrange.omitPriorError) prefix.splice(1, 1);
    if (arrange.foreignHistory) {
      const { responseId: _responseId, ...foreignAssistant } = assistant;
      prefix.push({ role: "user", content: "foreign question", timestamp: 3 }, {
        ...foreignAssistant, provider: "foreign", api: "foreign", model: "foreign",
        content: [{ type: "text", text: "foreign answer" }], timestamp: 4,
      });
    }
    let pending = arrange.pending;
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
    const listeners = new Map<AgyRuntime, Parameters<AgyRuntime["onEvent"]>[0]>();
    const lifecycle: string[] = [];
    t.mock.getter(AgyRuntime.prototype, "isRunning", () => arrange.outcome !== "dead" || start.mock.callCount() !== 1);
    t.mock.getter(BridgeIPC.prototype, "hasPendingCalls", function (this: BridgeIPC) { return this === oldMcp && pending; });
    t.mock.getter(BridgeIPC.prototype, "processEnvironment", () => ({}));
    t.mock.method(AgyBridge.prototype, "ensureAgyPluginInstalled", async () => {});
    t.mock.method(BridgeIPC.prototype, "start", async () => {});
    t.mock.method(BridgeIPC.prototype, "close", async () => { lifecycle.push("close"); });
    t.mock.method(AgyRuntime.prototype, "abort", async () => { lifecycle.push("abort"); });
    const start = t.mock.method(AgyRuntime.prototype, "start", async function (this: AgyRuntime) {
      const attempt = start.mock.callCount() + 1;
      lifecycle.push(`start:${this.options.conversationId ?? "fresh"}`);
      if (attempt === 1 && ["reject", "abort", "fallbackReject"].includes(arrange.outcome)) {
        if (arrange.outcome === "abort") controller.abort(new Error("startup aborted"));
        throw new Error("resume rejected");
      }
      if (attempt === 2 && arrange.outcome === "fallbackReject") throw new Error("fresh rejected");
      return { event: "init", conversation_id: arrange.outcome === "mismatch" || !this.options.conversationId
        ? "fresh-conversation" : this.options.conversationId } as Awaited<ReturnType<AgyRuntime["start"]>>;
    });
    const wait = t.mock.method(BridgeIPC.prototype, "waitForConnection", async () => {
      if (start.mock.callCount() === 1 && arrange.outcome === "waitReject") throw new Error("connection rejected");
    });
    t.mock.method(AgyRuntime.prototype, "onEvent", function (this: AgyRuntime, listener: Parameters<AgyRuntime["onEvent"]>[0]) {
      listeners.set(this, listener);
      return () => { listeners.delete(this); };
    });
    const finish = (proc: AgyRuntime) => {
      const listener = listeners.get(proc);
      assert.ok(listener, "subscribe before delivering runtime results");
      listener({ event: "step_update", delta: "finished" }, "agy");
      listener({ event: "result", status: "success", conversation_id: proc === oldProc ? "same-conversation" : session.conversationId! }, "agy");
    };
    const send = t.mock.method(AgyRuntime.prototype, "send", async function (this: AgyRuntime, _input: AgyInput) {
      if (arrange.outcome === "sendReject") throw new Error("active turn failed");
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

    const terminal = await run(selected);

    assert.equal(start.mock.callCount(), expected.starts);
    assert.equal(send.mock.callCount(), expected.sends);
    assert.equal(wait.mock.callCount(), expected.waits);
    if (expected.terminal !== "done") {
      assert.ok(terminal?.type === "error");
      assert.equal(terminal.reason, expected.terminal);
      assert.equal(session.activeProcess, null);
      assert.equal(session.activeMcpServer, null);
      assert.equal(resolve.mock.callCount(), 0);
      const stored = await bridge.runtimeSessionStore.get(sessionId);
      assert.equal(stored?.conversationId, expected.store === "retained" ? arrange.conversationId : undefined);
      assert.equal(listeners.size, 0);
      return;
    }

    assert.ok(terminal?.type === "done");
    assert.equal(terminal.message.model, expected.model);
    assert.equal(terminal.message.responseId, expected.responseId);
    assert.equal(session.activeProcess?.options.model, expected.model);
    assert.equal(session.activeProcess?.options.conversationId, expected.runtimeConversation);
    assert.equal(session.resources.terminals.resolve(terminalHandle), expected.preservesTerminal ? "pi-terminal" : undefined);
    assert.equal((await bridge.runtimeSessionStore.get(sessionId))?.conversationId, expected.responseId);
    assert.equal(listeners.size, 0);
    assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), context.messages.length + 1);

    if (expected.continuation.kind === "pending") {
      assert.equal(resolve.mock.callCount(), 1);
      assert.equal(session.activeProcess, oldProc);

      context.messages.push(terminal.message, { role: "user", content: "next request", timestamp: 6 });
      const next = await run(selected);

      assert.ok(next?.type === "done");
      assert.equal(next.message.model, selected.id);
      assert.equal(next.message.responseId, "same-conversation");
      assert.equal(start.mock.callCount(), 1);
      assert.equal(send.mock.callCount(), 1);
      assert.equal(session.activeProcess?.options.model, selected.id);
      assert.equal(session.activeProcess?.options.conversationId, "same-conversation");
      assert.equal(session.resources.terminals.resolve(terminalHandle), "pi-terminal");
      assert.equal(send.mock.calls[0]!.arguments[0].message.content, "next request");
      assert.equal((await bridge.runtimeSessionStore.get(sessionId))?.conversationId, next.message.responseId);
      assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), context.messages.length + 1);
      assert.equal(listeners.size, 0);
      return;
    }

    const prompt = send.mock.calls[0]!.arguments[0].message.content;
    if (expected.continuation.reconstructed) {
      const reconstructed = JSON.parse(prompt);
      assert.equal(reconstructed.purpose, "reconstructed_conversation");
      assert.equal(reconstructed.history.length, prefix.length);
      assert.equal(reconstructed.currentMessage.content, "new request");
      if (arrange.foreignHistory) assert.match(prompt, /foreign answer/);
      if (arrange.omitPriorError) assert.equal(prompt.includes(arrange.priorError!), false);
      else if (arrange.priorError) assert.deepEqual(reconstructed.history[1], {
        role: "assistant", content: assistant.content, stopReason: "error", errorMessage: arrange.priorError,
      });
    } else assert.equal(prompt, "new request");
    if (expected.continuation.fallback) assert.deepEqual(lifecycle.slice(0, 6), ["close", "abort", "start:same-conversation", "close", "abort", "start:fresh"]);
  });
}
