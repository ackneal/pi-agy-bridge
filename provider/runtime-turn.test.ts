import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BridgeIPC } from "../bridge/bridge-ipc.ts";
import { AgyRuntime } from "../runtime/process.ts";
import type { RuntimeSessionDecision } from "../session/session-state.ts";
import type { AgyEvent, AgyInput } from "../shared/types.ts";
import { AgyBridge, streamAgyProvider } from "./provider.ts";

const cases: RuntimeSessionDecision[] = [
  { action: "continue" },
  { action: "resume", conversationId: "old-conversation" },
  { action: "rebuild" },
];

for (const decision of cases) {
  test(`streamAgyProvider completes a ${decision.action} turn`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-runtime-turn-"));
    const pi = {
      on: () => {}, registerProvider: () => {},
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
    const model = {
      id: "test-model", name: "Test model", api: "agy", provider: "agy",
      baseUrl: "agy", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192, maxTokens: 1024,
    } as Model<any>;
    const events: AssistantMessageEvent[] = [];
    for await (const event of streamAgyProvider(model, context, { sessionId: "test-turn" }, config, bridge)) {
      events.push(event);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
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
    if (decision.action !== "rebuild") {
      assert.equal(prompt, "latest & request");
    } else {
      assert.equal(prompt, '<pi_context purpose="reconstructed_conversation">\n  <system_instructions>Rules &amp; constraints</system_instructions>\n  <history>\n    <message role="user">\n      <text>earlier &lt;question&gt;</text>\n    </message>\n  </history>\n  <current_message role="user">\n    <text>latest &amp; request</text>\n  </current_message>\n</pi_context>');
    }
    await bridge.liveSessions.disposeAll();
    assert.equal(close.mock.callCount(), 1);
    assert.equal(abort.mock.callCount(), 1);
  });
}

for (const scenario of ["pending tool results", "abort"] as const) {
  test(`streamAgyProvider continue handles ${scenario}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-runtime-continue-"));
    const pi = {
      on: () => {}, registerProvider: () => {},
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
    const resolve = t.mock.method(BridgeIPC.prototype, "resolveToolResults", () => {
      assert.ok(listener, "provider must subscribe before resolving tool results");
      if (scenario === "abort") return 0;
      const captured = listener;
      setImmediate(() => captured({ event: "result", status: "success" }));
      return 1;
    });
    t.mock.method(bridge.runtimeSessionSync, "decide", () => ({ action: "continue" }) as RuntimeSessionDecision);
    t.mock.method(bridge.runtimeSessionStore, "get", async () => undefined);
    const persist = t.mock.method(bridge.runtimeSessionStore, "set", async () => {});
    bridge.start();
    const session = bridge.liveSessions.getOrCreate("continue-regression");
    const proc = new AgyRuntime({ agentName: "pi-bridge", model: "test-model" });
    const mcp = new BridgeIPC([], session.id, session.resources);
    session.setSession(proc, "old-sync-key", mcp, "old-conversation");
    const context: Context = {
      messages: scenario === "pending tool results"
        ? [{ role: "toolResult", toolCallId: "pending-call", toolName: "test-tool", content: [{ type: "text", text: "tool answer" }], isError: false, timestamp: 2 }]
        : [{ role: "user", content: "latest request", timestamp: 2 }],
      tools: [],
    };
    const model = {
      id: "test-model", name: "Test model", api: "agy", provider: "agy",
      baseUrl: "agy", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192, maxTokens: 1024,
    } as Model<any>;
    const events: AssistantMessageEvent[] = [];
    for await (const event of streamAgyProvider(model, context, {
      sessionId: "continue-regression", signal: controller.signal,
    }, config, bridge)) {
      events.push(event);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(resolve.mock.callCount(), 1);
    assert.deepEqual(resolve.mock.calls[0]!.arguments, [context.messages]);
    assert.equal(unsubscribe.mock.callCount(), 1);
    assert.equal(listener, undefined);
    if (scenario === "pending tool results") {
      assert.equal(send.mock.callCount(), 0);
      assert.equal(events.at(-1)?.type, "done");
      assert.equal(events.some((event) => event.type === "error"), false);
      assert.equal(session.turnIndex, 1);
      assert.equal(persist.mock.callCount(), 2);
      assert.deepEqual(persist.mock.calls[0]!.arguments, [
        session.piSessionId, { conversationId: "old-conversation" }, context.messages,
      ]);
      const terminal = events.at(-1);
      assert.ok(terminal?.type === "done");
      assert.deepEqual(persist.mock.calls[1]!.arguments[2], [...context.messages, terminal.message]);
      assert.equal(session.activeProcess, proc);
      assert.equal(close.mock.callCount(), 0);
      assert.equal(abort.mock.callCount(), 0);
    } else {
      assert.equal(send.mock.callCount(), 1);
      const terminal = events.at(-1);
      assert.ok(terminal?.type === "error");
      assert.equal(terminal.reason, "aborted");
      assert.equal(session.activeProcess, null);
      assert.equal(close.mock.callCount(), 1);
      assert.equal(abort.mock.callCount(), 1);
      await bridge.liveSessions.disposeAll();
      assert.equal(close.mock.callCount(), 1);
      assert.equal(abort.mock.callCount(), 1);
    }
  });
}
