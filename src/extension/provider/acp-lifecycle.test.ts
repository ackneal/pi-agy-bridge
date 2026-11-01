import { fileURLToPath } from "node:url";
import { useAuthHomeFixture } from "./auth-home-fixture.ts";
import assert from "node:assert/strict";
import test, { describe, type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { Model, Context, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai";
import type { DriverSession, PrepareDriverInput, RuntimeEvent } from "../drivers/types.ts";
import { BridgeIPC } from "../bridge/ipc.ts";
import { Driver as CliDriver } from "../drivers/cli/driver.ts";
import { RuntimeSession as AcpRuntimeSession } from "../drivers/acp/runtime.ts";
import { Session as AcpSession } from "../drivers/acp/session.ts";
import { composeSystemPrompt, fingerprintSystemPrompt } from "../drivers/acp/instructions.ts";
import { useExecutable } from "../drivers/acp/executable-fixture.ts";
import { prepareSystemMessages } from "./context-prompt.ts";
import { CapabilityGateway } from "../bridge/capabilities.ts";
import { Bridge, streamProvider } from "./provider.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

useAuthHomeFixture();

async function createAcpHome(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agy-acp-provider-"));
  const previousHome = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = directory;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

const acpBoundaryModel: Model<"agy"> = {
  id: "selected", name: "Synthetic", api: "agy", provider: "agy", baseUrl: "agy",
  reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("ACP accounting at the provider boundary", () => {
  for (const standalone of [false, true]) {
    test(`accounting uses ${standalone ? "summary result" : "separate session entry"}`, async (t) => {
      const directory = await createAcpHome(t);
      const bridge = new Bridge({ getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI);
      const manager = SessionManager.inMemory(directory);
      const sessionId = standalone ? "summary-routing-id" : bridge.piContextAdapter.bind(manager);
      const model = { ...acpBoundaryModel, contextWindow: 1048576 };
      const accounting = { input: 109048, output: 15092, cacheRead: 1267257, cacheWrite: 0,
        reasoning: 7137, totalTokens: 1391397, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      t.after(() => bridge.liveSessions.disposeAll());
      t.mock.method(bridge.driver, "validateSelection", () => {});
      t.mock.method(bridge.runtimeSessionStore, "set", async () => {});
      t.mock.method(bridge.driver, "prepareSession", async (input: PrepareDriverInput) => {
        const mcpServer = new BridgeIPC([], input.session.id, input.session.resources);
        let handler: ((event: RuntimeEvent) => void) | undefined;
        const proc: DriverSession = {
          driver: "acp", isRunning: true,
          onRuntimeEvent: (next) => { handler = next; return () => { handler = undefined; }; },
          serializeContextUpdate: () => "",
          abort: async () => {},
          submit: async (submission) => {
            assert.equal(submission.beforeInput(), true);
            assert.ok(handler);
            handler({ type: "usage", usage: { ...accounting, input: 0, output: 0, cacheRead: 0, reasoning: 0, totalTokens: 164101 } });
            handler({ type: "accounting", usage: accounting });
            handler({ type: "complete", reason: "stop", resumable: true });
          },
        };
        assert.equal(input.session.setSession(proc, "settings", mcpServer, "native-session", input.preparationId), true);
        return { proc, mcpServer, reconstructContext: true, modelId: "actual-model" };
      });

      const message = await streamProvider(model, { messages: [{ role: "user", content: "test", timestamp: 1 }] }, {
        sessionId, ...(standalone ? { cacheRetention: "none" as const } : {}),
      }, bridge).result();

      assert.equal(message.stopReason, "stop", message.errorMessage ?? "native completion");
      const entries = manager.getEntries().filter((entry) => entry.type === "usage");
      if (standalone) {
        assert.deepEqual(entries, []);
        assert.deepEqual(message.usage, accounting, "Pi's summary caller must receive accounting");
      } else {
        assert.equal(entries.length, 1);
        assert.deepEqual(entries[0]!.usage, accounting);
        assert.equal(entries[0]!.provider, "agy");
        assert.equal(entries[0]!.model, "actual-model");
        assert.equal(message.usage.totalTokens, 164101);
        assert.equal(message.usage.input + message.usage.output + message.usage.cacheRead, 0);
        assert.equal(isContextOverflow(message, model.contextWindow), false);
      }
    });
  }
});

describe("ACP instruction compatibility", () => {
  for (const scenario of ["unchanged sections", "changed section", "removed section", "unchanged legacy", "changed legacy"] as const) {
    test(`ACP instructions at provider boundary: ${scenario}`, { timeout: 10000 }, async (t) => {
      const legacy = scenario.includes("legacy");
      const changed = !scenario.startsWith("unchanged");
      const pi = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
      const directory = await mkdtemp(path.join(os.tmpdir(), "agy-acp-instructions-"));
      const previousGeminiHome = process.env.GEMINI_HOME;
      process.env.GEMINI_HOME = directory;
      t.after(() => {
        if (previousGeminiHome === undefined) delete process.env.GEMINI_HOME;
        else process.env.GEMINI_HOME = previousGeminiHome;
        return rm(directory, { recursive: true, force: true });
      });
      const executable = path.join(directory, "acp");
      await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types "${fileURLToPath(new URL("../drivers/acp/session-fixture.ts", import.meta.url))}"\n`, { mode: 0o755 });
      useExecutable(t, executable);
      const bridge = new Bridge(pi);
      const sessionId = bridge.piContextAdapter.bind(SessionManager.inMemory(os.tmpdir()));
      const session = bridge.liveSessions.getOrCreate(sessionId);
      const tools = [{ name: "read", description: "Synthetic read", parameters: { type: "object", properties: {} } }];
      const gateway = new CapabilityGateway(tools, session.resources);
      t.after(async () => {
        gateway.cancelPendingCalls("cleanup");
        await bridge.liveSessions.disposeAll();
      });
      t.mock.method(bridge, "getTools", () => tools);
      t.mock.method(BridgeIPC.prototype, "start", async () => {});
      t.mock.getter(BridgeIPC.prototype, "bridgeUri", () => "unix:///synthetic.sock");
      t.mock.getter(BridgeIPC.prototype, "hasPendingCalls", () => gateway.hasPendingCalls);
      t.mock.method(BridgeIPC.prototype, "setToolCallHandler", (handler: Parameters<BridgeIPC["setToolCallHandler"]>[0]) => gateway.setToolCallHandler(handler));
      const resolve = t.mock.method(BridgeIPC.prototype, "resolveToolResults", (messages: Context["messages"], appendix?: string) => gateway.resolveToolResults(messages, appendix));
      t.mock.method(BridgeIPC.prototype, "close", async () => { gateway.cancelPendingCalls("closed"); });
      const prompts: Parameters<AcpSession["prompt"]>[0][] = [];
      let oldResult: unknown;
      t.mock.method(AcpSession.prototype, "prompt", function (content: Parameters<AcpSession["prompt"]>[0]): ReturnType<AcpSession["prompt"]> {
        prompts.push(content);
        if (prompts.length > 1) return Promise.resolve({ stopReason: "end_turn" });
        return gateway.call("read", { path: "synthetic.txt" }).then((result) => {
          oldResult = result;
          return { stopReason: "end_turn" };
        });
      });
      const collect = async (context: Context) => {
        const events: AssistantMessageEvent[] = [];
        for await (const event of streamProvider(acpBoundaryModel, context, { sessionId }, bridge)) events.push(event);
        const last = events.at(-1);
        assert.ok(last?.type === "done", JSON.stringify(last));
        return last;
      };
      const context: Context = {
        tools,
        ...(legacy ? { systemPrompt: "PRIVATE_BASE\n\nPRIVATE_SECTION" } : {}),
        messages: [
          ...(!legacy ? [{ role: "system" as const, content: "PRIVATE_BASE", sections: { policy: "PRIVATE_SECTION" }, timestamp: 0 }] : []),
          { role: "user", content: "Read synthetic.txt", timestamp: 1 },
        ],
      };
      const first = await collect(context);
      assert.equal(first.reason, "toolUse");
      const runtime = session.activeProcess;
      assert.ok(runtime instanceof AcpRuntimeSession);
      assert.equal(runtime.options.systemPrompt, composeSystemPrompt(prepareSystemMessages(context)));
      assert.ok(runtime.options.systemPrompt?.includes("PRIVATE_SECTION"));
      assert.equal(runtime.compatibilityKey, fingerprintSystemPrompt(JSON.stringify([path.join(process.env.GEMINI_HOME!, "antigravity-acp"), composeSystemPrompt(prepareSystemMessages(context))])));
      assert.equal((await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion))?.compatibilityKey, runtime.compatibilityKey);
      assert.ok(!JSON.stringify(prompts[0]).includes("PRIVATE_"));
      assert.ok(gateway.hasPendingCalls);

      const call = first.message.content.find((part) => part.type === "toolCall");
      assert.ok(call?.type === "toolCall");
      const result = { role: "toolResult" as const, toolCallId: call.id, toolName: "read", content: [{ type: "text" as const, text: "HISTORICAL_COMPLETED_RESULT" }], isError: false, timestamp: 3 };
      const next: Context = {
        ...context,
        ...(legacy && changed ? { systemPrompt: "PRIVATE_CHANGED" } : {}),
        messages: [...context.messages, first.message, result,
          ...(!legacy && changed ? [{ role: "system" as const, content: "", sections: { policy: scenario === "removed section" ? null : "PRIVATE_CHANGED" }, timestamp: 4 }] : []),
        ],
      };
      const second = await collect(next);
      assert.equal(second.reason, "stop");
      const active = session.activeProcess;
      assert.ok(active instanceof AcpRuntimeSession);
      assert.equal(active.options.systemPrompt, composeSystemPrompt(prepareSystemMessages(next)));
      assert.equal((await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion))?.compatibilityKey, fingerprintSystemPrompt(JSON.stringify([path.join(process.env.GEMINI_HOME!, "antigravity-acp"), composeSystemPrompt(prepareSystemMessages(next))])));
      if (changed) {
        assert.notEqual(active, runtime);
        assert.equal(resolve.mock.callCount(), 0);
        assert.equal(prompts.length, 2);
        const replay = JSON.stringify(prompts[1]);
        assert.ok(replay.includes("synthetic.txt"));
        assert.ok(!replay.includes("HISTORICAL_COMPLETED_RESULT"));
        assert.ok(!replay.includes("PRIVATE_"));
        assert.ok(!JSON.stringify(oldResult).includes("HISTORICAL_COMPLETED_RESULT"));
        if (scenario === "removed section") assert.ok(!active.options.systemPrompt?.includes("PRIVATE_SECTION"));
      } else {
        assert.equal(active, runtime);
        assert.equal(resolve.mock.callCount(), 1);
        assert.equal(prompts.length, 1);
        assert.ok(JSON.stringify(oldResult).includes("HISTORICAL_COMPLETED_RESULT"));
      }
      assert.equal(gateway.hasPendingCalls, false);
    });
  }

});
describe("ACP tool announcements", () => {
  for (const row of [
    { scenario: "native-execute", tool: "run_command", args: { command: "echo synthetic" } },
    { scenario: "native-read", tool: "view_file", args: { absolute_path: "/synthetic/input.txt" } },
    { scenario: "native-search", tool: "grep_search", args: { query: "synthetic" } },
    { scenario: "native-unknown", tool: "unknown_tool", args: { value: "synthetic" } },
  ]) {
    test(`announced ${row.scenario} warns in Pi without invalidating the ACP runtime`, async (t) => {
      let start!: (event: SessionStartEvent, ctx: ExtensionContext) => void;
      const notify = t.mock.fn();
      const pi = {
        getActiveTools: () => [], getAllTools: () => [], registerCommand: () => {}, registerProvider: () => {},
        on: (event: string, handler: typeof start) => { if (event === "session_start") start = handler; },
      } as unknown as ExtensionAPI;
      const directory = await createAcpHome(t);
      const executable = path.join(directory, "acp");
      await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types "${fileURLToPath(new URL("../drivers/acp/session-fixture.ts", import.meta.url))}" ${row.scenario}\n`, { mode: 0o755 });
      useExecutable(t, executable);
      const bridge = new Bridge(pi);
      const sessionManager = SessionManager.inMemory(os.tmpdir());
      const sessionId = bridge.piContextAdapter.bind(sessionManager);
      const session = bridge.liveSessions.getOrCreate(sessionId);
      t.after(() => bridge.liveSessions.disposeAll());
      t.mock.method(bridge, "getTools", () => []);
      t.mock.method(BridgeIPC.prototype, "start", async () => {});
      t.mock.getter(BridgeIPC.prototype, "bridgeUri", () => "unix:///synthetic.sock");
      const close = t.mock.method(BridgeIPC.prototype, "close", async () => {});
      bridge.start();
      start({ type: "session_start", reason: "reload" }, {
        sessionManager, hasUI: true, ui: { notify }, modelRegistry: { refresh: async () => {} },
      } as unknown as ExtensionContext);

      const events: AssistantMessageEvent[] = [];
      for await (const event of streamProvider(acpBoundaryModel, {
        messages: [{ role: "user", content: "Use only Pi tools", timestamp: 0 }],
      }, { sessionId }, bridge)) events.push(event);

      const terminal = events.filter(event => event.type === "done" || event.type === "error");
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0]?.type, "done");
      assert.ok(session.activeProcess instanceof AcpRuntimeSession);
      assert.equal(session.activeProcess.isRunning, true);
      assert.ok(session.activeMcpServer);
      assert.equal(close.mock.callCount(), 0);
      assert.equal(notify.mock.callCount(), 1);
      assert.deepEqual(notify.mock.calls[0]!.arguments, [
        `Antigravity ACP: unverified tool activity — ${row.tool} ${JSON.stringify(row.args)}`, "warning",
      ]);
      const checkpoint = await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion);
      assert.equal(checkpoint?.sessionId, session.activeProcess.session.id);
    });
  }

});
describe("ACP pending tool lifecycle", () => {
  for (const scenario of ["completion", "cancel", "failure", "unknown", "missing", "duplicate"] as const) {
    test(`ACP provider tool gap: ${scenario}`, { timeout: 10000 }, async (t) => {
      const pi = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
      const directory = await createAcpHome(t);
      const executable = path.join(directory, "acp");
      await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types "${fileURLToPath(new URL("../drivers/acp/session-fixture.ts", import.meta.url))}"\n`, { mode: 0o755 });
      useExecutable(t, executable);
      assert.equal(new Bridge(pi).driver.id, "acp");
      assert.equal(new Bridge(pi, new CliDriver()).driver.id, "cli");
      const bridge = new Bridge(pi);
      assert.equal(bridge.driver.id, "acp");
      const sessionId = bridge.piContextAdapter.bind(SessionManager.inMemory(os.tmpdir()));
      const session = bridge.liveSessions.getOrCreate(sessionId);
      const tools = [{ name: "read", description: "Synthetic read", parameters: { type: "object", properties: {} } }];
      const gateway = new CapabilityGateway(tools, session.resources);
      t.after(async () => {
        await bridge.liveSessions.disposeAll();
        gateway.cancelPendingCalls("cleanup");
      });
      t.mock.method(bridge, "getTools", () => tools);
      const install = t.mock.method(CliDriver.prototype, "installPlugin", async () => { throw new Error("ACP must not install CLI plugins"); });
      t.mock.method(BridgeIPC.prototype, "start", async () => {});
      t.mock.getter(BridgeIPC.prototype, "bridgeUri", () => "unix:///synthetic.sock");
      t.mock.getter(BridgeIPC.prototype, "hasPendingCalls", () => gateway.hasPendingCalls);
      t.mock.method(BridgeIPC.prototype, "setToolCallHandler", (handler: Parameters<BridgeIPC["setToolCallHandler"]>[0]) => gateway.setToolCallHandler(handler));
      const resolve = t.mock.method(BridgeIPC.prototype, "resolveToolResults", (messages: Context["messages"], appendix?: string) => gateway.resolveToolResults(messages, appendix));
      const close = t.mock.method(BridgeIPC.prototype, "close", async () => { gateway.cancelPendingCalls("closed"); });
      const prepare = t.mock.method(AcpSession.prototype, "prepare");
      let rejectPrompt!: (error: Error) => void;
      const prompt = t.mock.method(AcpSession.prototype, "prompt", function (this: AcpSession, content: Parameters<AcpSession["prompt"]>[0]): ReturnType<AcpSession["prompt"]> {
        assert.equal(this.id, "synthetic-session");
        assert.ok(content.length);
        return new Promise((resolve, reject) => {
          rejectPrompt = reject;
          void gateway.call("read", { path: "synthetic.txt" }).then((result) => {
            if (!result.isError) resolve({ stopReason: "end_turn" });
          });
        });
      });
      const cancel = AcpSession.prototype.cancel;
      t.mock.method(AcpSession.prototype, "cancel", async function (this: AcpSession) {
        try { await cancel.call(this); }
        finally { rejectPrompt?.(new Error("synthetic native prompt cancelled")); }
      });
      const controller = new AbortController();
      const context: Context = { tools, messages: [{ role: "user", content: "Read synthetic.txt", timestamp: 1 }] };
      const collect = async (input: Context) => {
        const events: AssistantMessageEvent[] = [];
        for await (const event of streamProvider(acpBoundaryModel, input, { sessionId, signal: controller.signal }, bridge)) events.push(event);
        assert.equal(events.filter((event) => event.type === "done" || event.type === "error").length, 1);
        return events.at(-1)!;
      };

      const first = await collect(context);
      assert.ok(first.type === "done");
      assert.equal(first.reason, "toolUse");
      assert.equal(first.message.responseId, "synthetic-session");
      const call = first.message.content[0];
      assert.ok(call?.type === "toolCall");
      assert.equal(call.name, "read");
      assert.deepEqual(call.arguments, { path: "synthetic.txt" });
      const runtime = session.activeProcess;
      assert.ok(runtime instanceof AcpRuntimeSession);
      assert.equal(runtime.session.id, first.message.responseId);
      assert.equal(session.driverId, "acp");
      assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), 2);
      assert.equal((await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion))?.sessionId, runtime.session.id);
      assert.equal(await bridge.runtimeSessionStore.get(sessionId, "cli:v1"), undefined);

      if (scenario === "cancel" || scenario === "failure") {
        if (scenario === "cancel") controller.abort();
        else {
          const failed = new Promise<void>(resolve => runtime.onRuntimeEvent(event => {
            if (event.type === "complete") resolve();
          }));
          rejectPrompt(new Error("synthetic native prompt failed"));
          await failed;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(session.activeProcess, null);
        assert.equal(session.activeMcpServer, null);
        assert.equal(await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion), undefined);
        assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), 2);
        assert.equal(close.mock.callCount(), 1);
        assert.equal(resolve.mock.callCount(), 0);
      } else {
        const result = { role: "toolResult" as const, toolCallId: scenario === "unknown" ? "unknown-call" : call.id, toolName: "read", content: [{ type: "text" as const, text: "synthetic answer" }], isError: false, timestamp: 3 };
        const results = scenario === "missing" ? [] : scenario === "duplicate" ? [result, result] : [result];
        const second = await collect({ tools, messages: [...context.messages, first.message, ...results] });
        if (scenario === "completion") {
          assert.ok(second.type === "done");
          assert.equal(second.reason, "stop");
          assert.equal(second.message.responseId, runtime.session.id);
          assert.equal(session.activeProcess, runtime);
          assert.equal(session.conversationId, runtime.session.id);
          assert.equal(close.mock.callCount(), 0);
          assert.equal(gateway.hasPendingCalls, false);
          assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), 4);
        } else {
          assert.ok(second.type === "error");
          assert.equal(second.reason, "error");
          assert.match(second.error.errorMessage!, scenario === "unknown" ? /Unknown tool result ID: unknown-call/ : scenario === "duplicate" ? /Duplicate tool result ID:/ : /Missing tool result ID:/);
          assert.equal(session.activeProcess, null);
          assert.equal(await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion), undefined);
          assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), 2);
          assert.equal(close.mock.callCount(), 1);
        }
        assert.equal(resolve.mock.callCount(), 1);
      }
      assert.equal(prompt.mock.callCount(), 1);
      assert.equal(prepare.mock.callCount(), 1);
      assert.equal(install.mock.callCount(), 0);
    });
  }

});
describe("ACP resume recovery", () => {
  test("ACP provider falls back to new session when resume fails", { timeout: 10000 }, async (t) => {
    const pi = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-acp-provider-"));
    const previousGeminiHome = process.env.GEMINI_HOME;
    process.env.GEMINI_HOME = directory;
    t.after(() => {
      if (previousGeminiHome === undefined) delete process.env.GEMINI_HOME;
      else process.env.GEMINI_HOME = previousGeminiHome;
      return rm(directory, { recursive: true, force: true });
    });
    const executable = path.join(directory, "acp");
    await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types "${fileURLToPath(new URL("../drivers/acp/session-fixture.ts", import.meta.url))}"\n`, { mode: 0o755 });
    useExecutable(t, executable);
    const bridge = new Bridge(pi);
    const sessionId = bridge.piContextAdapter.bind(SessionManager.inMemory(os.tmpdir()));
    const session = bridge.liveSessions.getOrCreate(sessionId);
    await bridge.runtimeSessionStore.set(sessionId, {
      sessionId: "stale-session-id",
      compatibilityKey: fingerprintSystemPrompt(JSON.stringify([path.join(process.env.GEMINI_HOME!, "antigravity-acp"), composeSystemPrompt(prepareSystemMessages({ messages: [] }))])),
    }, [], bridge.driver.sessionVersion);
    t.after(async () => {
      await bridge.liveSessions.disposeAll();
    });
    t.mock.method(bridge, "getTools", () => []);
    t.mock.method(BridgeIPC.prototype, "start", async () => {});
    t.mock.getter(BridgeIPC.prototype, "bridgeUri", () => "unix:///synthetic.sock");
    t.mock.getter(BridgeIPC.prototype, "hasPendingCalls", () => false);
    t.mock.method(BridgeIPC.prototype, "close", async () => {});
    const originalPrepare = AcpSession.prototype.prepare;
    let prepareAttempts = 0;
    t.mock.method(AcpSession.prototype, "prepare", async function (this: AcpSession, signal?: AbortSignal) {
      prepareAttempts++;
      if (prepareAttempts === 1) {
        throw new Error("Synthetic session not found on server");
      }
      return originalPrepare.call(this, signal);
    });
    t.mock.method(AcpSession.prototype, "prompt", async () => ({ stopReason: "end_turn" }));

    const events: AssistantMessageEvent[] = [];
    const context: Context = { tools: [], messages: [{ role: "user", content: "hello", timestamp: 1 }] };
    for await (const event of streamProvider(acpBoundaryModel, context, { sessionId }, bridge)) events.push(event);

    assert.equal(prepareAttempts, 2);
    assert.equal(session.driverId, "acp");
    assert.equal(session.conversationId, "synthetic-session");
    assert.equal((await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion))?.sessionId, "synthetic-session");
    assert.equal(events.at(-1)?.type, "done");
  });
});
