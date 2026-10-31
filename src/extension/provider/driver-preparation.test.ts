import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import type { Context, Model, Tool } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BridgeIPC } from "../bridge/ipc.ts";
import { CapabilityGateway } from "../bridge/capabilities.ts";
import { Connection as AcpConnection } from "../drivers/acp/connection.ts";
import { Driver as AcpDriver } from "../drivers/acp/driver.ts";
import { useAcpExecutable } from "../drivers/acp/executable-fixture.ts";
import { RuntimeSession as AcpRuntimeSession } from "../drivers/acp/runtime.ts";
import { Driver as CliDriver } from "../drivers/cli/driver.ts";
import { RuntimeSession as CliRuntimeSession } from "../drivers/cli/runtime.ts";
import { SessionMode, type BridgeMessage, type ContentPart, type PrepareDriverInput } from "../drivers/types.ts";
import { AgyRuntime } from "../runtime/process.ts";
import { LiveSession } from "../session/session.ts";
import { Bridge, streamProvider } from "./provider.ts";

const model: Model<"agy"> = {
  id: "selected", name: "Synthetic", api: "agy", provider: "agy", baseUrl: "agy",
  reasoning: false, input: ["text", "image"], contextWindow: 8192, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const tools: Tool[] = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }];
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const nativeImage = { type: "image" as const, data: "bmF0aXZl", mimeType: "image/png" };
const modes = [SessionMode.Conversation, SessionMode.Standalone];

async function preparationFixture(t: TestContext, id: "cli" | "acp", onPrompt?: () => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "agy-driver-preparation-"));
  const previousHome = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = directory;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  });
  useAcpExecutable(t, process.execPath);

  // Reuse the version-only executable pattern from runtime-start.test.ts.
  const executable = path.join(directory, "agy");
  await writeFile(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo 1.2.14\nelse\n  exit 1\nfi\n', { mode: 0o755 });
  const driver = id === "cli" ? new CliDriver() : new AcpDriver();
  if (driver instanceof CliDriver) {
    t.mock.method(driver, "detectExecutable", () => executable);
    t.mock.method(driver, "installPlugin", async () => {});
  }
  const bridge = new Bridge({ getActiveTools: () => ["read"], getAllTools: () => tools } as unknown as ExtensionAPI, driver);
  t.after(() => bridge.liveSessions.disposeAll());
  const starts = t.mock.method(BridgeIPC.prototype, "start", async () => {});
  t.mock.getter(BridgeIPC.prototype, "bridgeUri", () => "unix:///synthetic.sock");
  const closes = t.mock.method(BridgeIPC.prototype, "close");
  const get = t.mock.method(bridge.runtimeSessionStore, "get");
  const set = t.mock.method(bridge.runtimeSessionStore, "set");
  const invalidate = t.mock.method(bridge.runtimeSessionStore, "delete");
  const payloads: (string | acp.ContentBlock[])[] = [];
  const metadata: (acp.NewSessionRequest | acp.LoadSessionRequest)[] = [];
  const order: string[] = [];
  const cliOptions: AgyRuntime["options"][] = [];
  let listener: Parameters<AgyRuntime["onEvent"]>[0] | undefined;
  t.mock.method(AgyRuntime.prototype, "onEvent", (handler: Parameters<AgyRuntime["onEvent"]>[0]) => {
    listener = handler;
    return () => { listener = undefined; };
  });
  t.mock.getter(AgyRuntime.prototype, "isRunning", () => true);
  t.mock.method(AgyRuntime.prototype, "start", async function (this: AgyRuntime) {
    cliOptions.push(this.options);
    order.push("new");
    return { event: "init" as const, conversation_id: "native-session" };
  });
  const aborts = t.mock.method(AgyRuntime.prototype, "abort", async () => {});
  t.mock.method(AgyRuntime.prototype, "send", async (input: Parameters<AgyRuntime["send"]>[0]) => {
    assert.equal(input.event, "user");
    assert.ok("message" in input);
    payloads.push(input.message.content);
    order.push("prompt");
    if (onPrompt) await onPrompt();
    assert.ok(listener);
    listener({ event: "result", status: "success", conversation_id: "native-session" }, "agy");
  });

  const settings: Record<string, string> = { mode: "default", model: model.id };
  const configuration = (): acp.SessionConfigOption[] => Object.entries(settings).map(([key, value]) => ({
    id: key, name: key, type: "select", currentValue: value, options: [{ name: value, value }],
  }));
  t.mock.getter(AcpConnection.prototype, "isRunning", () => true);
  t.mock.method(AcpConnection.prototype, "start", async (): Promise<acp.InitializeResponse> => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true, _meta: { antigravity: { systemPrompt: { append: true } } } },
  }));
  const disposals = t.mock.method(AcpConnection.prototype, "dispose", async () => {});
  t.mock.method(AcpConnection.prototype, "notify", async () => {});
  t.mock.method(AcpConnection.prototype, "request", async <M extends acp.AgentRequestMethod>(
    method: M, params: acp.AgentRequestParamsByMethod[M],
  ): Promise<acp.AgentRequestResponsesByMethod[M]> => {
    let response: unknown;
    if (method === acp.methods.agent.session.new || method === acp.methods.agent.session.load) {
      metadata.push(params as acp.NewSessionRequest | acp.LoadSessionRequest);
      order.push(method === acp.methods.agent.session.new ? "new" : "load");
      response = { sessionId: "native-session", configOptions: configuration() };
    } else if (method === acp.methods.agent.session.setConfigOption) {
      const option = params as acp.SetSessionConfigOptionRequest;
      settings[option.configId] = String(option.value);
      response = { configOptions: configuration() };
    } else if (method === acp.methods.agent.session.prompt) {
      payloads.push((params as acp.PromptRequest).prompt);
      order.push("prompt");
      if (onPrompt) await onPrompt();
      response = { stopReason: "end_turn" };
    } else {
      throw new Error(`Unexpected native request: ${method}`);
    }
    return response as acp.AgentRequestResponsesByMethod[M];
  });

  return { directory, bridge, driver, starts, closes, get, set, invalidate, payloads, metadata, order, cliOptions, aborts, disposals };
}

for (const id of ["cli", "acp"] as const) {
  for (const mode of modes) {
    test(`Provider -> actual ${id}.prepareSession: ${mode}`, { timeout: 5000 }, async (t) => {
      const fixture = await preparationFixture(t, id);
      const { directory, bridge, payloads, metadata, order } = fixture;
      const standalone = mode === SessionMode.Standalone;
      const sessionId = standalone ? "summary-routing-id" : bridge.piContextAdapter.bind(SessionManager.inMemory(directory));
      const imagePath = path.join(directory, "image.png");
      await writeFile(imagePath, Buffer.from(png, "base64"));
      const context: Context = { tools, messages: [
        { role: "system", content: "RESOLVED_RULE", timestamp: 0 },
        { role: "user", content: [{ type: "text", text: "before native" }, nativeImage,
          { type: "text", text: `between ${imagePath} after path` }], timestamp: 1 },
      ] };

      const result = await streamProvider(model, context, {
        sessionId, ...(standalone ? { cacheRetention: "none" } : {}),
      }, bridge).result();
      // Provider emits completion before standalone disposal finishes.
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(result.stopReason, "stop", result.errorMessage ?? "native completion");
      assert.deepEqual(order, ["new", "prompt"], "session metadata must precede the only native prompt");
      assert.equal(payloads.length, 1);
      assert.equal(fixture.starts.mock.callCount(), standalone ? 0 : 1);
      if (id === "cli") {
        const options = fixture.cliOptions[0]!;
        assert.equal(options.agentName, standalone ? "pi-standalone" : "pi-bridge");
        if (standalone) assert.deepEqual(options.environment, {});
        else assert.equal(options.environment?.PI_AGY_BRIDGE_MCP_ENDPOINT, "unix:///synthetic.sock");
        const agent = await readFile(new URL(`../../../plugin/agents/${options.agentName}.md`, import.meta.url), "utf8");
        assert.match(agent, /excludeDefaultComponents: true/);
        // CLI conversation mode retains only the guarded native artifact reader.
        assert.match(agent, standalone ? /inheritMcp: false\ntools: \[\]/ : /inheritMcp: true\ntools: \[view_file\]/);
        assert.equal(payloads[0], `[System]: RESOLVED_RULE\n\nbefore native\n\nbetween ${imagePath} after path`);
      } else {
        assert.equal(metadata.length, 1);
        const meta = metadata[0]!._meta?.antigravity as { enabledTools: unknown; systemPrompt: { append: string } };
        assert.deepEqual(meta.enabledTools, [], "native tools are disabled in both modes");
        assert.equal(metadata[0]!.mcpServers.length, standalone ? 0 : 1);
        if (!standalone) assert.equal(metadata[0]!.mcpServers[0]!.name, "pi-agy-bridge_pi");
        assert.ok(meta.systemPrompt.append.endsWith("RESOLVED_RULE"));
        if (standalone) assert.equal(meta.systemPrompt.append, "RESOLVED_RULE");
        else assert.ok(meta.systemPrompt.append.startsWith("# Tool and Conversation Protocol"));
        assert.deepEqual(payloads[0], [
          { type: "text", text: "before native" }, nativeImage,
          { type: "text", text: `between ${imagePath}` },
          { type: "image", data: png, mimeType: "image/png" },
          { type: "text", text: " after path" },
        ]);
      }
      if (standalone) {
        assert.equal(fixture.get.mock.callCount(), 0);
        assert.equal(fixture.set.mock.callCount(), 0);
        assert.equal(fixture.invalidate.mock.callCount(), 0);
        assert.equal(fixture.closes.mock.callCount(), 1);
        assert.ok((id === "cli" ? fixture.aborts : fixture.disposals).mock.callCount() > 0);
      } else {
        const active = bridge.liveSessions.getOrCreate(sessionId).activeProcess;
        assert.ok(id === "cli" ? active instanceof CliRuntimeSession : active instanceof AcpRuntimeSession);
        assert.equal(fixture.get.mock.callCount(), 1);
        assert.equal(fixture.set.mock.callCount(), 1);
      }
    });
  }
}

for (const mode of modes) {
  for (const operation of ["new", "load"] as const) {
    test(`actual AcpDriver.prepareSession: ${mode} ${operation === "load" ? "with compatible checkpoint" : "new"} metadata uses contract system, not raw Context`, async (t) => {
      const { bridge, driver, metadata, payloads, directory, order, get } = await preparationFixture(t, "acp");
      const sessionId = bridge.piContextAdapter.bind(SessionManager.inMemory(directory));
      const session = new LiveSession(sessionId);
      t.after(() => session.dispose());
      const context: Context = { systemPrompt: "WRONG_RAW_SYSTEM", messages: [{ role: "user", content: "question", timestamp: 1 }] };
      const messages: readonly BridgeMessage[] = [{ role: "system", content: "CONTRACT_SYSTEM" }];
      const input: PrepareDriverInput = {
        model, context, messages, tools: mode === SessionMode.Standalone ? [] : tools, options: undefined,
        session, preparationId: session.beginPreparation(), store: bridge.runtimeSessionStore, sync: bridge.runtimeSessionSync, mode,
      };
      if (operation === "load") {
        const initial = await driver.prepareSession(input);
        assert.ok(initial.proc.compatibilityKey);
        await bridge.runtimeSessionStore.set(sessionId, {
          sessionId: "native-session", compatibilityKey: initial.proc.compatibilityKey,
        }, context.messages, driver.sessionVersion);
        await session.dispose();
        input.preparationId = session.beginPreparation();
        metadata.length = 0;
        order.length = 0;
      }

      const runtime = await driver.prepareSession(input);

      assert.ok(runtime.proc instanceof AcpRuntimeSession);
      const expected = mode === SessionMode.Standalone ? "new" : operation;
      assert.deepEqual(order, [expected]);
      assert.equal(get.mock.callCount(), mode === SessionMode.Standalone ? 0 : operation === "load" ? 2 : 1);
      assert.equal(payloads.length, 0, "preparation must never submit a prompt");
      assert.equal(metadata.length, 1);
      if (expected === "load") assert.equal((metadata[0] as acp.LoadSessionRequest).sessionId, "native-session");
      const meta = metadata[0]!._meta?.antigravity as { enabledTools: unknown; systemPrompt: { append: string } };
      assert.deepEqual(meta.enabledTools, []);
      assert.equal(metadata[0]!.mcpServers.length, mode === SessionMode.Standalone ? 0 : 1);
      assert.ok(!meta.systemPrompt.append.includes("WRONG_RAW_SYSTEM"));
      if (mode === SessionMode.Standalone) assert.equal(meta.systemPrompt.append, "CONTRACT_SYSTEM");
      else {
        assert.ok(meta.systemPrompt.append.startsWith("# Tool and Conversation Protocol"));
        assert.ok(meta.systemPrompt.append.endsWith("# Working Instructions\n\nCONTRACT_SYSTEM"));
      }
    });
  }
}

for (const id of ["cli", "acp"] as const) {
  test(`Provider -> actual ${id}.prepareSession: MCP continuation reuses the pending native prompt`, { timeout: 5000 }, async (t) => {
    // Reuse the in-memory MCP transport arrangement from acp-instructions.test.ts.
    const gateway = new CapabilityGateway(tools);
    t.after(() => gateway.cancelPendingCalls("cleanup"));
    let toolResult: unknown;
    const { bridge, directory, payloads, order, metadata, cliOptions, starts } = await preparationFixture(t, id, async () => {
      toolResult = await gateway.call("read", { path: "synthetic.txt" });
    });
    t.mock.getter(BridgeIPC.prototype, "hasPendingCalls", () => gateway.hasPendingCalls);
    t.mock.method(BridgeIPC.prototype, "setToolCallHandler", (handler: Parameters<BridgeIPC["setToolCallHandler"]>[0]) => gateway.setToolCallHandler(handler));
    t.mock.method(BridgeIPC.prototype, "resolveToolResults", (messages: Context["messages"], appendix?: string) => gateway.resolveToolResults(messages, appendix));
    const sessionId = bridge.piContextAdapter.bind(SessionManager.inMemory(directory));
    const context: Context = { systemPrompt: "CONTINUATION_RULE", tools, messages: [
      { role: "user", content: "Read synthetic.txt", timestamp: 1 },
    ] };

    const first = await streamProvider(model, context, { sessionId }, bridge).result();
    assert.equal(first.stopReason, "toolUse", first.errorMessage ?? "native tool handoff");
    assert.ok(gateway.hasPendingCalls);
    const runtime = bridge.liveSessions.getOrCreate(sessionId).activeProcess;
    const call = first.content.find((part) => part.type === "toolCall");
    assert.ok(call?.type === "toolCall");
    const next: Context = { ...context, messages: [...context.messages, first, {
      role: "toolResult", toolCallId: call.id, toolName: "read", isError: false,
      content: [{ type: "text", text: "FILE_CONTENT" }], timestamp: 3,
    }, { role: "user", content: "Apply this correction before continuing", timestamp: 4 }] };
    const second = await streamProvider(model, next, { sessionId }, bridge).result();

    assert.equal(second.stopReason, "stop", second.errorMessage ?? "continued native completion");
    assert.equal(bridge.liveSessions.getOrCreate(sessionId).activeProcess, runtime);
    assert.deepEqual(order, ["new", "prompt"]);
    assert.equal(payloads.length, 1, "MCP results must not start a second native prompt");
    assert.equal(starts.mock.callCount(), 1);
    assert.equal(id === "acp" ? metadata.length : cliOptions.length, 1);
    assert.equal(gateway.hasPendingCalls, false);
    assert.match(JSON.stringify(toolResult), /FILE_CONTENT/);
    assert.match(JSON.stringify(toolResult), /Apply this correction before continuing/);
  });
}

for (const id of ["cli", "acp"] as const) {
  test(`actual ${id}.prepareSession: Standalone bypasses checkpoints and conversation synchronization`, async (t) => {
    const { bridge, driver, directory, starts, get } = await preparationFixture(t, id);
    const session = new LiveSession("standalone-summary");
    t.after(() => session.dispose());
    const decide = t.mock.method(bridge.runtimeSessionSync, "decide", () => {
      assert.fail("Standalone must not select a conversation checkpoint or live runtime");
    });
    const runtime = await driver.prepareSession({
      model, context: { messages: [] }, messages: [{ role: "system", content: "SUMMARY_RULE" }], tools: [],
      options: undefined, session, preparationId: session.beginPreparation(),
      store: bridge.runtimeSessionStore, sync: bridge.runtimeSessionSync, mode: SessionMode.Standalone,
    });

    assert.equal(runtime.reconstructContext, true);
    assert.equal(get.mock.callCount(), 0);
    assert.equal(decide.mock.callCount(), 0);
    assert.equal(starts.mock.callCount(), 0);
    assert.ok(runtime.proc instanceof (id === "cli" ? CliRuntimeSession : AcpRuntimeSession));
    assert.equal(runtime.proc.options.cwd, path.join(directory, id === "cli" ? "antigravity-cli" : "antigravity-acp"));
  });
}

for (const mode of modes) {
  for (const row of [
    { name: "whitespace-only string", content: " \n\t", expected: [{ type: "text", text: " \n\t" }] },
    { name: "whitespace around images", content: [
      { type: "text", text: "before" }, { type: "text", text: " \n\t" }, nativeImage,
      { type: "text", text: "\n " }, { type: "text", text: "after" },
    ], expected: [
      { type: "text", text: "before" }, { type: "text", text: " \n\t" }, nativeImage,
      { type: "text", text: "\n " }, { type: "text", text: "after" },
    ] },
  ] satisfies { name: string; content: string | ContentPart[]; expected: acp.ContentBlock[] }[]) {
    test(`Provider -> actual ACP preparation: ${mode} preserves ${row.name}`, async (t) => {
      const { bridge, directory, payloads } = await preparationFixture(t, "acp");
      const standalone = mode === SessionMode.Standalone;
      const sessionId = standalone ? "whitespace-summary" : bridge.piContextAdapter.bind(SessionManager.inMemory(directory));
      const result = await streamProvider(model, {
        messages: [{ role: "user", content: row.content, timestamp: 1 }],
      }, { sessionId, ...(standalone ? { cacheRetention: "none" } : {}) }, bridge).result();
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(result.stopReason, "stop", result.errorMessage ?? "native completion");
      assert.deepEqual(payloads, [row.expected]);
    });
  }
}
