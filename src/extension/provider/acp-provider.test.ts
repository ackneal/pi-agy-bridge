import { useAuthHomeFixture } from "./auth-home-fixture.ts";
import assert from "node:assert/strict";
import { AgyAuthentication } from "./auth.ts";
import { AcpDriver } from "../drivers/acp/driver.ts";
import { useAcpExecutable } from "../drivers/acp/executable-fixture.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test, { afterEach, beforeEach, mock } from "node:test";
import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { BridgeIPC } from "../bridge/ipc.ts";
import { CliDriver } from "../drivers/cli/driver.ts";
import { CapabilityGateway } from "../bridge/capabilities.ts";
import { AcpRuntimeSession } from "../drivers/acp/runtime.ts";
import { AcpSession } from "../drivers/acp/session.ts";
import { composeAcpSystemPrompt, fingerprintAcpSystemPrompt } from "../drivers/acp/instructions.ts";
import { Bridge, streamAgyProvider } from "./provider.ts";

useAuthHomeFixture();

let home: string;
let previousHome: string | undefined;
beforeEach(async () => {
  mock.method(AgyAuthentication.prototype, "detect", async () => undefined);
  home = await mkdtemp(path.join(tmpdir(), "agy-native-home-"));
  previousHome = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = home;
});
afterEach(async () => {
  mock.restoreAll();
  if (previousHome === undefined) delete process.env.GEMINI_HOME;
  else process.env.GEMINI_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

const model = {
  id: "selected", name: "Synthetic", api: "agy", provider: "agy", baseUrl: "agy",
  reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<any>;

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
    const directory = await mkdtemp(path.join(tmpdir(), "agy-acp-provider-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = path.join(directory, "acp");
    await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types "${fileURLToPath(new URL("../drivers/acp/session-fixture.ts", import.meta.url))}" ${row.scenario}\n`, { mode: 0o755 });
    useAcpExecutable(t, executable);
    const bridge = new Bridge(pi);
    const sessionManager = SessionManager.inMemory(tmpdir());
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
    for await (const event of streamAgyProvider(model, {
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
    const checkpoint = await bridge.runtimeSessionStore.get(sessionId, undefined, bridge.driver.sessionVersion);
    assert.equal(checkpoint?.sessionId, session.activeProcess.session.id);
  });
}

for (const scenario of ["completion", "cancel", "failure", "unknown", "missing", "duplicate"] as const) {
  test(`ACP provider tool gap: ${scenario}`, { timeout: 10000 }, async (t) => {
    const pi = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
    const directory = await mkdtemp(path.join(tmpdir(), "agy-acp-provider-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = path.join(directory, "acp");
    await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types "${fileURLToPath(new URL("../drivers/acp/session-fixture.ts", import.meta.url))}"\n`, { mode: 0o755 });
    useAcpExecutable(t, executable);
    assert.equal(new Bridge(pi).driver.id, "acp");
    assert.equal(new Bridge(pi, new CliDriver()).driver.id, "cli");
    const bridge = new Bridge(pi);
    assert.equal(bridge.driver.id, "acp");
    const sessionId = bridge.piContextAdapter.bind(SessionManager.inMemory(tmpdir()));
    const session = bridge.liveSessions.getOrCreate(sessionId);
    const tools = [{ name: "read", description: "Synthetic read", parameters: { type: "object", properties: {} } }];
    const gateway = new CapabilityGateway(tools, session.resources);
    t.after(async () => {
      await bridge.liveSessions.disposeAll();
      gateway.cancelPendingCalls("cleanup");
      t.mock.restoreAll();
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
      for await (const event of streamAgyProvider(model, input, { sessionId, signal: controller.signal }, bridge)) events.push(event);
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
    assert.equal((await bridge.runtimeSessionStore.get(sessionId, undefined, bridge.driver.sessionVersion))?.sessionId, runtime.session.id);
    assert.equal(await bridge.runtimeSessionStore.get(sessionId, undefined, "cli:v1"), undefined);

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
      assert.equal(await bridge.runtimeSessionStore.get(sessionId, undefined, bridge.driver.sessionVersion), undefined);
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
        assert.equal(await bridge.runtimeSessionStore.get(sessionId, undefined, bridge.driver.sessionVersion), undefined);
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

test("ACP provider falls back to new session when resume fails", { timeout: 10000 }, async (t) => {
  const pi = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
  const directory = await mkdtemp(path.join(tmpdir(), "agy-acp-provider-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = path.join(directory, "acp");
    await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types "${fileURLToPath(new URL("../drivers/acp/session-fixture.ts", import.meta.url))}"\n`, { mode: 0o755 });
    useAcpExecutable(t, executable);
  const bridge = new Bridge(pi);
  const sessionId = bridge.piContextAdapter.bind(SessionManager.inMemory(tmpdir()));
  const session = bridge.liveSessions.getOrCreate(sessionId);
  await bridge.runtimeSessionStore.set(sessionId, {
    sessionId: "stale-session-id",
    compatibilityKey: fingerprintAcpSystemPrompt(JSON.stringify([path.join(process.env.GEMINI_HOME!, "antigravity-acp"), composeAcpSystemPrompt({ messages: [] })])),
  }, [], undefined, bridge.driver.sessionVersion);
  t.after(async () => {
    await bridge.liveSessions.disposeAll();
    t.mock.restoreAll();
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
  for await (const event of streamAgyProvider(model, context, { sessionId }, bridge)) events.push(event);

  assert.equal(prepareAttempts, 2);
  assert.equal(session.driverId, "acp");
  assert.equal(session.conversationId, "synthetic-session");
  assert.equal((await bridge.runtimeSessionStore.get(sessionId, undefined, bridge.driver.sessionVersion))?.sessionId, "synthetic-session");
  assert.equal(events.at(-1)?.type, "done");
});

test("agy-bridge:driver command shows status and switches active driver", async (t) => {
  const registeredCommands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const sentMessages: { customType?: string; content: string }[] = [];
  const pi = {
    getActiveTools: () => [],
    getAllTools: () => [],
    registerCommand: (name: string, options: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
      registeredCommands.set(name, options.handler);
    },
    registerProvider: () => {},
    sendMessage: (msg: { customType?: string; content: string }) => {
      sentMessages.push(msg);
    },
    on: () => {},
  } as unknown as ExtensionAPI;

  const bridge = new Bridge(pi);
  t.after(() => bridge.liveSessions.disposeAll());
  t.mock.method(CliDriver.prototype, "usage", async () => undefined);
  t.mock.method(AcpDriver.prototype, "usage", async () => undefined);
  const setStatus = t.mock.fn();
  const ctx = { hasUI: true, ui: { setStatus }, modelRegistry: { refresh: async () => {} } } as unknown as ExtensionCommandContext;
  t.mock.method(CliDriver.prototype, "detectExecutable", () => process.execPath);
  useAcpExecutable(t, process.execPath);
  t.mock.method(CliDriver.prototype, "discoverModels", async () => []);
  t.mock.method(AcpDriver.prototype, "discoverModels", async () => []);
  bridge.start();

  const handler = registeredCommands.get("agy-bridge:driver");
  assert.ok(handler);

  // 1. Status query
  await handler("", { ...ctx, hasUI: false });
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0]?.customType, "pi-agy-bridge:driver");
  assert.match(sentMessages[0]!.content, /Current driver: \*\*Antigravity ACP\*\* \(acp\)/);
  assert.match(sentMessages[0]!.content, /Available drivers:/);

  // 2. Unknown driver
  await handler("invalid-driver", ctx);
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[1]!.content, /Unknown driver "invalid-driver"/);

  // 3. Already active
  await handler("acp", ctx);
  assert.equal(sentMessages.length, 3);
  assert.match(sentMessages[2]!.content, /Already using driver/);

  assert.equal(setStatus.mock.callCount(), 0);

  // 4. Switch to CLI
  await handler("cli", ctx);
  assert.equal(sentMessages.length, 4);
  assert.match(sentMessages[3]!.content, /Antigravity CLI/);
  assert.equal(bridge.driver.id, "cli");

  // 5. Switch back to ACP
  await handler("acp", ctx);
  assert.equal(sentMessages.length, 5);
  assert.match(sentMessages[4]!.content, /Antigravity ACP/);
  assert.equal(bridge.driver.id, "acp");
  for (const index of [3, 4]) {
    assert.equal(sentMessages[index]?.customType, "pi-agy-bridge:doctor");
    assert.match(sentMessages[index]!.content, /^agy-bridge doctor\n/);
  }
  assert.deepEqual(setStatus.mock.calls.map(call => call.arguments), [
    ["agy-bridge", "Switching to Antigravity CLI…"],
    ["agy-bridge", undefined],
    ["agy-bridge", "Checking Antigravity CLI diagnostics…"],
    ["agy-bridge", undefined],
    ["agy-bridge", "Switching to Antigravity ACP…"],
    ["agy-bridge", undefined],
    ["agy-bridge", "Checking Antigravity ACP diagnostics…"],
    ["agy-bridge", undefined],
  ]);
});

