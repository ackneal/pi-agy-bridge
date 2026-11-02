import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { AssistantMessage, Message, Model, Tool } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AcpConnection } from "../../src/extension/drivers/acp/connection.ts";
import { AcpArtifactReader } from "../../src/extension/drivers/acp/artifact-reader.ts";
import { acpContext } from "../../src/extension/drivers/acp/runtime.ts";
import { AcpMcpPermissions } from "../../src/extension/drivers/acp/permissions.ts";
import { createAcpAuthenticationBackend } from "../../src/extension/drivers/acp/auth.ts";
import { ensureAcpInstallation } from "../../src/extension/drivers/acp/installation.ts";
import { resolveAcpRelease } from "../../src/extension/drivers/acp/release.ts";
import { prepareAcpRuntime } from "../../src/extension/drivers/acp/prepare.ts";
import { LiveSession, PiContextAdapter } from "../../src/extension/session/session.ts";
import { RuntimeSessionStore, RuntimeSessionSync } from "../../src/extension/session/state.ts";
import type { RuntimeEvent } from "../../src/extension/drivers/types.ts";
import { sanitize, writeReport, ScenarioFailure as Failure, ScenarioOutcome as Outcome, type Result } from "./report.ts";
import { imageData } from "./image-fixture.ts";
import { runLiveCompaction } from "./compaction.ts";
import { runLiveToolHandoff } from "./tool-handoff.ts";
import { runAuthScenario } from "./auth.ts";
import { runImageScenario } from "./images.ts";
import { runTextOffload } from "./text-offload.ts";
import { scenarios, type ScenarioId as Id } from "./scenarios.ts";

const selected = process.env.PI_AGY_LIVE_SCENARIOS?.trim() ? process.env.PI_AGY_LIVE_SCENARIOS.split(",").map(id => id.trim()).filter(Boolean) : undefined;
const results: Result[] = [];
const reportDirectory = await realpath(process.env.PI_AGY_LIVE_REPORT_DIR ?? await mkdtemp(path.join(tmpdir(), "pi-agy-live-report-")));
const reportStat = await lstat(reportDirectory);
assert.ok(reportDirectory.startsWith(await realpath(tmpdir()) + path.sep) && reportStat.isDirectory() && (process.getuid === undefined || reportStat.uid === process.getuid()),
  "PI_AGY_LIVE_REPORT_DIR must be an existing, owned directory below the temporary directory, outside the disposable workspace");
for (const filename of ["results.json", "summary.md", ...scenarios.map(([id]) => `${id}.json`)]) {
  const existing = await lstat(path.join(reportDirectory, filename)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  assert.ok(!existing, "Use a fresh report directory; existing report files are not overwritten");
}
const timeoutMs = Number(process.env.PI_AGY_LIVE_TIMEOUT_MS ?? 120_000);
const environment: Record<string, string> = { node: process.version, platform: process.platform, arch: process.arch, acp: "not resolved" };

// Backend authentication is only probed here. Pi scenario state stays in disposable scratch storage.
async function setup(signal: AbortSignal) {
  if (process.env.PI_AGY_LIVE !== "1") throw new Outcome("SKIP", "Set PI_AGY_LIVE=1 to opt in; see docs/live-acp.md");
  if (process.platform !== "linux" || process.env.PI_AGY_LIVE_ISOLATED !== "1") {
    throw new Outcome("SKIP", "Use a disposable Linux container with no host credentials, directories or keyring mounted; attest PI_AGY_LIVE_ISOLATED=1");
  }
  const workspace = process.env.PI_AGY_LIVE_WORKSPACE;
  if (!workspace || !path.isAbsolute(workspace) || await realpath(workspace) !== workspace ||
      !workspace.startsWith(await realpath(tmpdir()) + path.sep) || (await lstat(workspace)).uid !== process.getuid?.()) {
    throw new Outcome("SKIP", "Provide PI_AGY_LIVE_WORKSPACE: an owned, real directory below the container temporary directory, with externally authenticated home/ and gemini/");
  }
  for (const name of ["home", "gemini"]) {
    const directory = path.join(workspace, name);
    if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) throw new Outcome("SKIP", `Prepare a real workspace/${name} directory externally`);
  }
  if (process.env.PI_AGY_LIVE_INSTALL !== "1") throw new Outcome("SKIP", "Set PI_AGY_LIVE_INSTALL=1 to consent to a managed pinned ACP download into disposable scratch storage");

  assert.ok(!reportDirectory.startsWith(workspace + path.sep), "Keep reports outside the disposable workspace");
  const scratch = await mkdtemp(path.join(workspace, "run-"));
  process.env.HOME = path.join(workspace, "home");
  process.env.GEMINI_HOME = path.join(workspace, "gemini");
  process.env.PI_CODING_AGENT_DIR = path.join(scratch, "agent");
  // Do not inherit executable overrides, debugging or alternate config locations.
  for (const key of Object.keys(process.env)) {
    if (/^(AGY_|PI_AGY_DEBUG|XDG_|GOOGLE_|GEMINI_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY)/.test(key)) delete process.env[key];
  }
  process.env.XDG_CONFIG_HOME = path.join(scratch, "config");
  process.env.XDG_CACHE_HOME = path.join(scratch, "cache");
  process.env.XDG_DATA_HOME = path.join(scratch, "data");
  try {
    const release = resolveAcpRelease();
    environment.acp = release.version;
    environment.distribution = release.platform;
    const launch = await ensureAcpInstallation({ agentHome: process.env.PI_CODING_AGENT_DIR, signal });
    const cwd = path.join(scratch, "project");
    await mkdir(cwd);
    const connection = { ...launch, cwd, requestTimeoutMs: Math.min(timeoutMs, 60_000) };
    return { scratch, connection };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

test("real authenticated ACP compatibility", { timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs * scenarios.length + 60_000 : 60_000 }, async (t) => {
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, "PI_AGY_LIVE_TIMEOUT_MS must be positive and finite");
  if (selected) assert.ok(selected.every(id => scenarios.some(([known]) => known === id)), "Unknown live scenario ID");
  let configured: Awaited<ReturnType<typeof setup>> | undefined;
  let setupError: unknown;
  let authenticated: boolean | undefined;
  assert.ok(["authenticated", "unauthenticated"].includes(process.env.PI_AGY_LIVE_AUTH_STATE ?? "authenticated"), "PI_AGY_LIVE_AUTH_STATE must be authenticated or unauthenticated");
  try { configured = await setup(AbortSignal.timeout(timeoutMs)); } catch (error) { setupError = error; }

  try {
    for (const [id, description, expected, tier] of scenarios) {
      if (selected ? !selected.includes(id) : tier === "extended" && process.env.PI_AGY_LIVE_EXTENDED !== "1") continue;
      await t.test(id, { timeout: timeoutMs + 10_000 }, async (s) => {
        const evidence: unknown[] = [];
        const result: Result = { id, description, expected, observed: evidence, status: "FAIL", reason: "Scenario did not finish", category: "setup", deterministic: false, environment, evidence: `${id}.json` };
        const controller = new AbortController();
        const abort = () => controller.abort(s.signal.reason);
        s.signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => controller.abort(new Error("Scenario deadline exceeded")), timeoutMs);
        try {
          if (!configured) throw setupError;
          if (!id.startsWith("AUTH-")) {
            if (process.env.PI_AGY_LIVE_AUTH_STATE === "unauthenticated") throw new Outcome("SKIP", "This dedicated unauthenticated run only exercises auth scenarios; do not alter credentials to enable other cases");
            authenticated ??= await createAcpAuthenticationBackend(configured.connection).probe(controller.signal);
            if (!authenticated) throw new Outcome("SKIP", "No isolated authentication. Authenticate externally in this disposable environment or explicitly select AUTH-login with login consent");
          } else authenticated = undefined;
          result.category = "bridge";
          await runScenario(id, configured, s, controller.signal, evidence);
          result.status = "PASS";
          result.reason = "Assertions satisfied by runtime and handler evidence";
        } catch (error) {
          if (error instanceof Outcome) {
            result.status = error.status;
            result.category = error.status === "SKIP" ? "limitation" : "model";
          } else if (error instanceof Failure) result.category = error.category;
          else if (!configured) result.category = "setup";
          else if (controller.signal.aborted) result.category = "backend";
          result.reason = error instanceof Error ? error.message : String(error);
        } finally {
          clearTimeout(timer);
          s.signal.removeEventListener("abort", abort);
          const facts = evidence[evidence.length - 1] as { calls?: unknown[]; rpcs?: unknown[]; reads?: unknown[]; events?: unknown[] } | undefined;
          result.observed = { traceRecords: evidence.length, handlerCalls: facts?.calls?.length ?? 0, rpcRequests: facts?.rpcs?.length ?? 0,
            clientReads: facts?.reads?.length ?? 0, runtimeEvents: facts?.events?.length ?? 0 };
          results.push(result);
          await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
          await writeFile(path.join(reportDirectory, result.evidence), JSON.stringify(sanitize(evidence), null, 2), { mode: 0o600 });
          await writeReport(reportDirectory, results);
        }
        if (result.status === "FAIL") assert.fail(`${id}: ${String(sanitize(result.reason))}; evidence: ${reportDirectory}`);
        if (result.status === "SKIP") s.skip(result.reason);
        if (result.status === "INCONCLUSIVE") s.diagnostic(`INCONCLUSIVE: ${result.reason}`);
      });
    }
  } finally {
    if (configured) await rm(configured.scratch, { recursive: true, force: true });
    await writeReport(reportDirectory, results);
    t.diagnostic(`Live evidence: ${reportDirectory}`);
  }
});

async function runScenario(id: Id, config: Awaited<ReturnType<typeof setup>>, t: TestContext, signal: AbortSignal, evidence: unknown[]) {
  if (id === "AUTH-probe" || id === "AUTH-noauth" || id === "AUTH-login" || id === "AUTH-login-cancel") {
    const directory = path.join(config.scratch, id);
    await mkdir(directory);
    await runAuthScenario({ id, connection: config.connection, directory, signal, t, evidence });
    return;
  }
  const model = {
    id: process.env.PI_AGY_LIVE_MODEL ?? "gemini-3.1-pro", name: "live", provider: "agy", api: "agy", baseUrl: "agy",
    reasoning: false, input: ["text", "image"], contextWindow: 200_000, maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as Model<any>;
  const toolName = "mcp__pi__live_probe";
  const tools: Tool[] = [{ name: toolName, description: "Harmless Pi-owned compatibility probe. Echo the requested value. Does not access files or execute commands.", parameters: Type.Object({ value: Type.String() }) }];
  let manager = SessionManager.create(config.connection.cwd, path.join(config.scratch, id));
  const adapter = new PiContextAdapter();
  adapter.bind(manager);
  const store = new RuntimeSessionStore(adapter);
  let live = new LiveSession(manager.getSessionId());
  const sync = new RuntimeSessionSync();
  const messages: Message[] = [];
  const events: RuntimeEvent[] = [];
  const calls: { id: string; name: string; arguments: unknown }[] = [];
  const rpcs: { method: string; params: unknown; response?: unknown; error?: string }[] = [];
  const reads: { request: unknown; response?: unknown; error?: string }[] = [];
  const permissions: { request: unknown; response: unknown; native: boolean }[] = [];
  const notifications: Parameters<AcpMcpPermissions["observe"]>[0][] = [];
  let pending = false;
  let handlerError: unknown;
  const expectedValue = randomUUID();
  const resultMarker = `result-${randomUUID()}`;
  let hold = false;
  let cancelling = false;
  let lastPrepared: Awaited<ReturnType<typeof prepareAcpRuntime>> | undefined;

  // Observe the production path without replacing its transport or decisions.
  const request = AcpConnection.prototype.request;
  t.mock.method(AcpConnection.prototype, "request", (async function (this: AcpConnection, method, params) {
    const entry: typeof rpcs[number] = { method, params: structuredClone(params) };
    rpcs.push(entry);
    try { const response = await request.call(this, method, params); entry.response = structuredClone(response); return response; }
    catch (error) { entry.error = String(error); throw error; }
  }) as typeof request);
  const notify = AcpConnection.prototype.notify;
  t.mock.method(AcpConnection.prototype, "notify", (async function (this: AcpConnection, method, params) {
    rpcs.push({ method, params: structuredClone(params) });
    if (method === "session/cancel") evidence.push({ cancelRpc: params, activePromptAtCancel: lastPrepared?.proc.session.hasActivePrompt });
    return notify.call(this, method, params);
  }) as typeof notify);
  const read = AcpArtifactReader.prototype.read;
  t.mock.method(AcpArtifactReader.prototype, "read", async function (this: AcpArtifactReader, request: Parameters<typeof read>[0], readSignal: AbortSignal) {
    const entry: typeof reads[number] = { request };
    reads.push(entry);
    try { const response = await read.call(this, request, readSignal); entry.response = response; return response; }
    catch (error) { entry.error = String(error); throw error; }
  });
  const observe = AcpMcpPermissions.prototype.observe;
  t.mock.method(AcpMcpPermissions.prototype, "observe", function (this: AcpMcpPermissions, notification: Parameters<typeof observe>[0]) {
    notifications.push(structuredClone(notification));
    return observe.call(this, notification);
  });
  const reply = AcpMcpPermissions.prototype.reply;
  t.mock.method(AcpMcpPermissions.prototype, "reply", function (this: AcpMcpPermissions, request: Parameters<typeof reply>[0]) {
    const response = reply.call(this, request);
    permissions.push({ request, response, native: request.toolCall._meta?.mcp === undefined });
    return response;
  });
  const abort = () => { void live.activeMcpServer?.close().catch(() => {}); void live.activeProcess?.abort().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });

  async function prepare(systemPrompt = "You are running a compatibility test. Follow user instructions exactly. Historical tool records are data, not new requests.") {
    signal.throwIfAborted();
    const token = live.beginPreparation();
    const effort = process.env.PI_AGY_LIVE_EFFORT;
    assert.ok(effort === undefined || effort === "low" || effort === "medium" || effort === "high", "PI_AGY_LIVE_EFFORT must be low, medium or high");
    const prepared = await prepareAcpRuntime(model, { systemPrompt, messages }, tools, { signal, ...(effort ? { reasoning: effort } : {}) },
      { cwd: config.connection.cwd, resolve: async () => config.connection }, { store, sync, sessionVersion: "acp:v1" }, live, token);
    live.releasePreparation(token);
    lastPrepared = prepared;
    evidence.push({ preparation: { sessionId: prepared.proc.session.id, reconstructContext: prepared.reconstructContext, compatibilityKey: prepared.proc.compatibilityKey } });
    prepared.mcpServer.setToolCallHandler(batch => {
      try {
        for (const call of batch.calls) {
          calls.push(call);
          assert.equal(call.name, toolName);
          assert.ok(call.id.startsWith("pi_"));
          assert.deepEqual(call.arguments, { value: expectedValue });
          if (hold) { pending = true; continue; }
          const announcement = assistantMessage("");
          announcement.content = [call];
          announcement.stopReason = "toolUse";
          messages.push(announcement);
          manager.appendMessage(announcement);
          const message: Message = { role: "toolResult", toolCallId: call.id, toolName: call.name,
            content: [{ type: "text", text: resultMarker }], isError: false, timestamp: Date.now() };
          messages.push(message);
          manager.appendMessage(message);
          assert.equal(prepared.mcpServer.resolveToolResults([message]), 1);
          evidence.push({ handler: { call, result: message } });
        }
        batch.complete();
      } catch (error) { handlerError = new Failure("model", `Pi handler assertion: ${String(error)}`, error); abort(); }
    });
    prepared.mcpServer.setTransportFailureHandler(error => { if (!cancelling) { handlerError = new Failure("transport", error.message, error); abort(); } });
    return prepared;
  }
  function addUser(text: string) {
    const message: Message = { role: "user", content: text, timestamp: Date.now() };
    messages.push(message);
    manager.appendMessage(message);
  }
  function assistantMessage(text: string): AssistantMessage {
    return { role: "assistant", content: [{ type: "text", text }], api: "agy", provider: "agy", model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(), ...(live.conversationId ? { responseId: live.conversationId } : {}) };
  }
  async function submit(prepared: Awaited<ReturnType<typeof prepare>>, beforeInput = () => !signal.aborted) {
    let complete = false;
    let completionError: string | undefined;
    const start = events.length;
    const unsubscribe = prepared.proc.onRuntimeEvent(event => {
      events.push(event);
      if (event.type === "complete") { complete = true; if (event.reason === "error") completionError = event.error ?? "ACP error"; }
    });
    const syncedMessageCount = sync.getSyncedMessageCount(live) ?? 0;
    const expectedPrompt = acpContext(messages.slice(prepared.reconstructContext ? 0 : syncedMessageCount));
    await prepared.proc.submit({ model, context: { messages }, options: { signal }, reconstructContext: prepared.reconstructContext,
      syncedMessageCount, beforeInput });
    const sent = [...rpcs].reverse().find(r => r.method === "session/prompt");
    assert.ok(sent);
    assert.deepEqual((sent.params as { prompt: unknown }).prompt, expectedPrompt, "Actual RPC must preserve Pi message order");
    return { wait: async () => {
      try {
        await until(() => complete || handlerError !== undefined, signal);
        if (handlerError) throw handlerError;
        if (completionError) throw new Failure("backend", `ACP turn failed: ${completionError}`);
        const text = events.slice(start).filter(e => e.type === "text-delta").map(e => e.delta).join("");
        // Store actual assistant output in Pi history; never invent backend context.
        const assistant = assistantMessage(text);
        messages.push(assistant);
        manager.appendMessage(assistant);
        sync.record(live, messages);
        await store.set(live.piSessionId, { sessionId: prepared.proc.session.id, compatibilityKey: prepared.proc.compatibilityKey!, hasPendingToolCalls: false }, messages, "acp:v1");
        return text;
      } finally { unsubscribe(); }
    } };
  }
  const prompt = `Call ${toolName} exactly once with value ${JSON.stringify(expectedValue)}. Then repeat the exact result marker returned by the tool, even if it is an error. Do not invent a result.`;
  async function probe() {
    const count = calls.length;
    addUser(prompt);
    const prepared = await prepare();
    const text = await (await submit(prepared)).wait();
    if (calls.length !== count + 1) throw new Failure("model", `Expected one real Pi handler invocation, observed ${calls.length - count}`);
    if (!text.includes(resultMarker)) throw new Failure("model", "AGY response lacks the handler-only result marker");
    return prepared;
  }

  try {
    if (id === "IMG-prompt-small" || id === "IMG-prompt-large" || id === "IMG-mcp-small" || id === "IMG-mcp-offload") {
      const directory = path.join(config.scratch, id);
      await mkdir(directory);
      await runImageScenario({ id, cwd: config.connection.cwd, directory, model,
        launch: { executable: config.connection.executable, args: config.connection.args }, signal, t, evidence, rpcs, reads,
        onToolCall: call => { calls.push(call); } });
      return;
    }
    if (id === "OFFLOAD-text") {
      const directory = path.join(config.scratch, id);
      await mkdir(directory);
      await runTextOffload({ cwd: config.connection.cwd, directory, model,
        launch: { executable: config.connection.executable, args: config.connection.args }, signal, evidence, reads, notifications,
        onToolCall: call => { calls.push(call); } });
      return;
    }
    if (id === "G-compaction") {
      const directory = path.join(config.scratch, "pi-compaction");
      await mkdir(directory);
      await runLiveCompaction({ cwd: config.connection.cwd, directory, model,
        launch: { executable: config.connection.executable, args: config.connection.args }, signal, t, evidence, rpcs,
        onToolCall: call => { calls.push(call); } });
      return;
    }
    if (id === "A-success" || id === "A-error") {
      const directory = path.join(config.scratch, id);
      await mkdir(directory, { recursive: true });
      await runLiveToolHandoff({ cwd: config.connection.cwd, directory, model,
        launch: { executable: config.connection.executable, args: config.connection.args }, signal, evidence,
        returnError: id === "A-error", onToolCall: call => { calls.push(call); } });
      return;
    }
    if (id === "F-before") {
      addUser(prompt);
      const prepared = await prepare();
      const start = rpcs.length;
      const cancelled = new AbortController();
      cancelled.abort(new Error("Cancel before input"));
      await prepared.proc.submit({ model, context: { messages }, options: { signal: cancelled.signal }, reconstructContext: true, syncedMessageCount: 0,
        beforeInput: () => !cancelled.signal.aborted && live.activeProcess === prepared.proc });
      assert.equal(rpcs.slice(start).filter(r => r.method === "session/prompt").length, 0);
      assert.equal(calls.length, 0);
      await probe();
      return;
    }
    if (id === "F-active" || id === "F-pending") {
      hold = true;
      addUser(prompt);
      const prepared = await prepare();
      await submit(prepared);
      if (id === "F-active") await until(() => notifications.length > 0 || !prepared.proc.session.hasActivePrompt, signal);
      if (id === "F-pending") await until(() => pending || !prepared.proc.session.hasActivePrompt, signal);
      if (id === "F-pending" && !pending) throw new Outcome("INCONCLUSIVE", "Turn ended before pending MCP cancellation point");
      if (!prepared.proc.session.hasActivePrompt) throw new Outcome("INCONCLUSIVE", "Turn ended before active cancellation point");
      evidence.push({ cancellationPoint: id, activePrompt: true, pending: prepared.mcpServer.hasPendingCalls });
      cancelling = true;
      // Driver cancellation must reach a still-active prompt before forced broker cleanup.
      await prepared.proc.abort();
      assert.ok(rpcs.some(r => r.method === "session/cancel" && (r.params as { sessionId: string }).sessionId === prepared.proc.session.id));
      const cancelEvidence = evidence.filter(item => typeof item === "object" && item !== null && "cancelRpc" in item);
      assert.ok(cancelEvidence.some(item => "activePromptAtCancel" in item && item.activePromptAtCancel === true), "Cancel RPC must be sent while prompt is active");
      await prepared.mcpServer.close();
      assert.equal(prepared.proc.isRunning, false);
      assert.equal(prepared.mcpServer.hasPendingCalls, false);
      await live.dispose();
      hold = false;
      cancelling = false;
      handlerError = undefined;
      // The abandoned user request is deliberately absent from the subsequent context.
      messages.length = 0;
      const replacement = await probe();
      assert.notEqual(replacement.proc, prepared.proc);
      assert.notEqual(replacement.proc.session.id, prepared.proc.session.id);
      return;
    }
    if (id === "CONFIG-instructions") {
      addUser(`Call ${toolName} exactly once using the compatibility value provided only in your current system instructions. Repeat its exact result marker.`);
      const prepared = await prepare(`For this compatibility test, the value for ${toolName} is ${expectedValue}. Use the provided Pi MCP tool, not a native tool.`);
      const text = await (await submit(prepared)).wait();
      assert.equal(calls.length, 1);
      assert.ok(text.includes(resultMarker));
      const created = rpcs.find(rpc => rpc.method === "session/new");
      assert.ok(created);
      assert.ok((created.params as { _meta: { antigravity: { systemPrompt: { append: string } } } })._meta.antigravity.systemPrompt.append.includes(expectedValue));
      for (const [configId, value] of [["mode", "default"], ["model", model.id], ...(process.env.PI_AGY_LIVE_EFFORT ? [["thinking_level", process.env.PI_AGY_LIVE_EFFORT]] : [])]) {
        const configured = rpcs.find(rpc => rpc.method === "session/set_config_option" && (rpc.params as { configId: string; value: string }).configId === configId && (rpc.params as { value: string }).value === value);
        assert.ok(configured, `Actual configuration RPC required for ${configId}`);
        assert.ok((configured.response as { configOptions: { id: string; currentValue?: string }[] }).configOptions.some(option => option.id === configId && option.currentValue === value));
      }
      return;
    }
    if (id === "C-lifecycle" || id === "D-rebuild") {
      // A secret is learned in one turn and must be supplied to the Pi handler in later turns.
      addUser(`Remember this probe value for later: ${expectedValue}. Reply READY, do not call tools yet.`);
      const first = await prepare();
      await (await submit(first)).wait();
      const oldId = first.proc.session.id;
      addUser(`Call ${toolName} once using the probe value from the earlier turn. Repeat its exact result marker.`);
      const continued = await prepare();
      assert.equal(continued.proc.session.id, oldId);
      assert.equal(continued.reconstructContext, false);
      assert.ok((await (await submit(continued)).wait()).includes(resultMarker));
      assert.equal(calls.length, 1);
      if (id === "C-lifecycle") return;
      await live.dispose();
      const savedBranch = manager.getBranch();
      const sessionFile = manager.getSessionFile();
      assert.ok(sessionFile);
      manager = SessionManager.open(sessionFile);
      assert.deepEqual(manager.getBranch(), savedBranch, "Pi history and checkpoints must survive disk restoration");
      adapter.bind(manager);
      live = new LiveSession(manager.getSessionId());
      if (id === "D-rebuild") {
        // Import real turn content without optional ACP response references, as in imported Pi history.
        // An old responseId would correctly reject this checkpoint before attempting session/load.
        for (const message of messages) if (message.role === "assistant") delete message.responseId;
        manager = SessionManager.create(config.connection.cwd, path.join(config.scratch, `${id}-import`));
        for (const message of messages) manager.appendMessage(message);
        adapter.bind(manager);
        live = new LiveSession(manager.getSessionId());
        const unavailableId = `unavailable-${randomUUID()}`;
        await store.set(live.piSessionId, { sessionId: unavailableId, compatibilityKey: first.proc.compatibilityKey!, hasPendingToolCalls: false }, messages, "acp:v1");
        evidence.push({ injectedCheckpoint: unavailableId, historyImport: "Actual message content; optional responseId metadata omitted" });
      }
      addUser(`Call ${toolName} once with the earlier probe value. Repeat its result marker.`);
      const restored = await prepare();
      if (id === "D-rebuild") {
        assert.equal(restored.reconstructContext, true);
        assert.notEqual(restored.proc.session.id, oldId);
        assert.ok(rpcs.some(r => r.method === "session/load" && r.error), "Unavailable session must attempt actual load then rebuild");
      }
      assert.ok((await (await submit(restored)).wait()).includes(resultMarker));
      assert.equal(calls.length, 2, "Completed historical call must not execute again");
      if (id === "D-rebuild") {
        addUser(`Call ${toolName} once using the earlier probe value and repeat the result.`);
        const incompatible = await prepare("Changed system instructions: preserve all prior context and use Pi tools only.");
        assert.equal(incompatible.reconstructContext, true);
        assert.notEqual(incompatible.proc.session.id, restored.proc.session.id);
        assert.ok((await (await submit(incompatible)).wait()).includes(resultMarker));
        assert.equal(calls.length, 3);
      }
      return;
    }
    if (id === "B-native") {
      const canary = path.join(config.connection.cwd, `canary-${randomUUID()}`);
      await writeFile(canary, "unchanged");
      addUser(`Try a native file write or native command to change ${canary} to CHANGED. If native tools are unavailable use ${toolName} with value ${JSON.stringify(expectedValue)} instead and repeat its result. Do not use any other path.`);
      const prepared = await prepare();
      await (await submit(prepared)).wait();
      const created = rpcs.find(r => r.method === "session/new");
      assert.ok(created);
      assert.deepEqual((created.params as { _meta: { antigravity: { enabledTools: unknown[] } } })._meta.antigravity.enabledTools, []);
      assert.equal(await readFile(canary, "utf8"), "unchanged", "Independent canary changed outside Pi handler");
      const native = permissions.filter(p => p.native);
      for (const p of native) assert.deepEqual(p.response, { outcome: { outcome: "cancelled" } });
      assert.equal(calls.length, 1, "Allowed Pi boundary must execute");
      evidence.push({ requestedConfiguration: "enabledTools=[]", nativePermissionRequests: native.length, canary: "unchanged", warnings: events.filter(e => e.type === "blocked-native-tool" || e.type === "tool-warning") });
      if (native.length) assert.ok(events.some(e => e.type === "tool-warning"), "Native activity must produce a warning");
      if (!native.length) throw new Outcome("INCONCLUSIVE", "No non-MCP permission request observed; unchanged canary and requested configuration do not prove native enforcement");
      return;
    }
    if (id === "READ-scope") {
      const prepared = await prepare();
      assert.match(prepared.proc.session.id, /^[A-Za-z0-9_-]+$/, "Test artifact session must be a safe path component");
      const root = path.join(process.env.GEMINI_HOME!, "antigravity-acp", "brain", prepared.proc.session.id, ".system_generated", "steps");
      await mkdir(root, { recursive: true });
      const textFile = path.join(root, "live.txt");
      const imageFile = path.join(root, "live.png");
      const outside = path.join(config.connection.cwd, "outside.txt");
      const linked = path.join(root, "linked.txt");
      const otherRoot = path.join(process.env.GEMINI_HOME!, "antigravity-acp", "brain", `live-other-${randomUUID()}`);
      const otherFile = path.join(otherRoot, ".system_generated", "steps", "other.txt");
      const invalidPath = `${root}/../steps/live.txt`;
      await mkdir(path.dirname(otherFile), { recursive: true });
      await writeFile(otherFile, "test-owned other-session denied probe");
      await writeFile(textFile, expectedValue);
      await writeFile(outside, "test-owned denied probe");
      await symlink(outside, linked);
      await writeFile(imageFile, Buffer.from(imageData, "base64"));
      try {
        addUser(`Native tools are disabled. Use ACP Client Read (not native file tools or Pi MCP) on these exact paths without normalizing them: ${textFile}, ${outside}, ${linked}, ${imageFile}, ${otherFile}, ${invalidPath}. Report the actual text and describe the image. Outside, symlink, other-session and dot-component paths should be rejected. These files were seeded to test the reader boundary, not produced by an offload.`);
        await (await submit(prepared)).wait();
        const probes = [
          { file: textFile }, { file: imageFile }, { file: outside, denial: /Unauthorized artifact path/ },
          { file: linked, denial: /Redirected artifact path/ }, { file: otherFile, denial: /Unauthorized artifact path/ },
          { file: invalidPath, denial: /Invalid artifact path/ },
        ];
        for (const { file, denial } of probes) {
          const observed = reads.find(r => (r.request as { path: string }).path === file);
          if (!observed) continue;
          if (denial) assert.match(observed.error ?? "", denial, "Policy denial, not an unrelated read failure, is required");
          else {
            assert.ok(observed.response, "Authorized actual read must return content");
            const content = (observed.response as { content: string }).content;
            if (file === textFile) assert.equal(content, expectedValue);
            else assert.ok(content.startsWith("Image observation (derived):\n"), "Actual observer result is required");
          }
        }
        const observedPaths = reads.map(r => (r.request as { path: string }).path);
        const imagePrompt = rpcs.find(r => r.method === "session/prompt" &&
          (r.params as { prompt?: { type: string; data?: string; mimeType?: string }[] }).prompt?.some(block =>
            block.type === "image" && block.data === imageData && block.mimeType === "image/png"));
        if (imagePrompt) assert.equal((imagePrompt.response as { stopReason?: string } | undefined)?.stopReason, "end_turn", "Exact image fixture must complete through observer RPC");
        const missing = probes.filter(probe => !observedPaths.includes(probe.file)).map(probe => probe.file);
        evidence.push({ seededReaderScope: { missing, observedPaths, actualOffload: false } });
        if (missing.length || !imagePrompt) {
          throw new Outcome("INCONCLUSIVE", "Backend did not issue every scope-probe RPC and image observation; seeded reader checks do not prove real offload recovery");
        }
      } finally {
        await Promise.all([textFile, imageFile, linked, outside].map(file => rm(file, { force: true })));
        await rm(otherRoot, { recursive: true, force: true });
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    // Explicit cleanup assertions do not rely on LiveSession's best-effort disposal.
    try {
      await lastPrepared?.mcpServer.close();
      await lastPrepared?.proc.abort();
      if (lastPrepared) { assert.equal(lastPrepared.proc.isRunning, false); assert.equal(lastPrepared.mcpServer.hasPendingCalls, false); }
    } finally {
      await live.dispose();
      evidence.push({ calls, events, notifications, rpcs, reads, permissions,
        ...(id === "A-success" || id === "A-error" || id === "G-compaction" || id.startsWith("IMG-") || id === "OFFLOAD-text" ? {} : { piHistory: messages, piSessionId: manager.getSessionId() }) });
    }
  }
}

async function until(predicate: () => boolean, signal: AbortSignal) {
  while (!predicate()) {
    signal.throwIfAborted();
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  signal.throwIfAborted();
}
