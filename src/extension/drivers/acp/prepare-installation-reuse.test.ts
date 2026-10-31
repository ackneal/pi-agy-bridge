import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { BridgeIPC } from "../../bridge/ipc.ts";
import { createMcpLaunchDescriptor } from "../../bridge/mcp-launch.ts";
import { defaultModelCatalog } from "../../discovery/model-metadata.ts";
import { calculateSyncKey, LiveSession } from "../../session/session.ts";
import { RuntimeSessionSync } from "../../session/state.ts";
import { prepareDriverCwd } from "../cwd.ts";
import { SessionMode, type PrepareDriverInput } from "../types.ts";
import { RuntimeSession as CliRuntimeSession } from "../cli/runtime.ts";
import { Connection } from "./connection.ts";
import { Driver } from "./driver.ts";
import { composeSystemPrompt } from "./instructions.ts";
import type { Launch } from "./installation.ts";
import { RuntimeSession } from "./runtime.ts";
import { prepareSystemMessages } from "../../provider/context-prompt.ts";

async function liveRuntime(t: TestContext, action: "continue" | "resume" | "rebuild", pendingTools = false, backend: "acp" | "cli" = "acp") {
  const home = await mkdtemp(path.join(os.tmpdir(), "acp-live-install-"));
  const previousHome = process.env.GEMINI_HOME;
  const previousOverride = process.env.AGY_ACP_BIN;
  process.env.GEMINI_HOME = home;
  delete process.env.AGY_ACP_BIN;
  const session = new LiveSession("installation-reuse");
  t.after(async () => {
    try { await session.dispose(); }
    finally {
      if (previousHome === undefined) delete process.env.GEMINI_HOME;
      else process.env.GEMINI_HOME = previousHome;
      if (previousOverride === undefined) delete process.env.AGY_ACP_BIN;
      else process.env.AGY_ACP_BIN = previousOverride;
      await rm(home, { recursive: true, force: true });
    }
  });

  const model = defaultModelCatalog()[0]!;
  const context = { messages: [] };
  const messages = prepareSystemMessages(context);
  const systemPrompt = composeSystemPrompt(messages);
  const runtime = backend === "cli"
    ? new CliRuntimeSession({ agentName: "pi-bridge", model: model.id }, new Set(), {})
    : new RuntimeSession({
      executable: process.execPath, cwd: prepareDriverCwd("acp"), model: model.id, systemPrompt,
      mcp: createMcpLaunchDescriptor("unix:///unused"),
    });
  const mcp = new BridgeIPC([], session.id, session.resources);
  const preparationId = session.beginPreparation();
  const syncKey = pendingTools ? "previous tool signatures" : calculateSyncKey(systemPrompt, [], model.id, "", "acp");
  session.setSession(runtime, syncKey, mcp, "conversation", preparationId);
  if (action === "rebuild") session.compatibilityKey = "incompatible instructions";
  t.mock.getter(runtime, "isRunning", () => action !== "resume");
  t.mock.getter(mcp, "hasPendingCalls", () => pendingTools);
  const abort = t.mock.method(runtime, "abort", async () => {});
  const close = t.mock.method(mcp, "close", async () => {});
  const start = t.mock.method(Connection.prototype, "start", async () => { throw new Error("Unexpected ACP launch"); });
  const sync = new RuntimeSessionSync();
  sync.record(session, context.messages);
  const decide = t.mock.method(sync, "decide", sync.decide.bind(sync));
  const input: PrepareDriverInput = {
    model, context, messages, tools: [], options: undefined, session, preparationId, sync,
    store: { get: async () => undefined, delete: async () => {} },
    mode: SessionMode.Conversation,
  };
  return { input, runtime, mcp, abort, close, start, decide };
}

for (const row of [
  { name: "compatible running process", action: "continue", pendingTools: false },
  { name: "pending tools with changed tool signatures", action: "continue", pendingTools: true },
  { name: "resume requires installation", action: "resume", pendingTools: false },
  { name: "rebuild requires installation", action: "rebuild", pendingTools: false },
] as const) {
  test(`ACP installation resolution: ${row.name}`, async (t) => {
    const f = await liveRuntime(t, row.action, row.pendingTools);
    const failure = new Error("Damaged companion; offline installation repair failed");
    const resolve = t.mock.fn(async () => { throw failure; });
    const driver = new Driver(resolve);

    const preparing = driver.prepareSession(f.input);
    if (row.action === "continue") {
      const result = await preparing;
      assert.equal(result.proc, f.runtime);
      assert.equal(result.mcpServer, f.mcp);
      assert.equal(result.reconstructContext, false);
    } else await assert.rejects(preparing, (error) => error === failure);

    assert.deepEqual(f.decide.mock.calls.map((call) => call.result), [row.action === "resume"
      ? { action: "resume", conversationId: "conversation" } : { action: row.action }]);
    assert.equal(resolve.mock.callCount(), row.action === "continue" ? 0 : 1);
    assert.equal(f.abort.mock.callCount(), 0);
    assert.equal(f.close.mock.callCount(), 0);
    assert.equal(f.start.mock.callCount(), 0);
    assert.equal(f.input.session.activeProcess, f.runtime);
  });
}

for (const outcome of ["aborted", "superseded"] as const) {
  test(`ACP installation resolution ${outcome} before launch preserves the existing runtime`, async (t) => {
    const f = await liveRuntime(t, "rebuild");
    const controller = new AbortController();
    f.input.options = { signal: controller.signal };
    let release!: (launch: Launch) => void;
    let entered!: () => void;
    const gate = new Promise<Launch>((resolve) => { release = resolve; });
    const resolving = new Promise<void>((resolve) => { entered = resolve; });
    const driver = new Driver(async () => { entered(); return gate; });
    const settled = driver.prepareSession(f.input).then(value => ({ value }), error => ({ error }));
    t.after(async () => { release({ executable: process.execPath, args: [] }); await settled; });

    await resolving;
    if (outcome === "aborted") controller.abort(new Error("cancel installation preparation"));
    else f.input.session.beginPreparation();
    release({ executable: process.execPath, args: [] });
    const result = await settled;

    assert.ok("error" in result);
    assert.match(String(result.error), outcome === "aborted" ? /cancel installation preparation/ : /superseded/);
    assert.equal(f.abort.mock.callCount(), 0);
    assert.equal(f.close.mock.callCount(), 0);
    assert.equal(f.start.mock.callCount(), 0);
    assert.equal(f.input.session.activeProcess, f.runtime);
  });
}

for (const outcome of ["failed", "aborted", "superseded"] as const) {
  test(`cross-driver preparation preserves CLI when ACP resolution is ${outcome}`, async (t) => {
    const f = await liveRuntime(t, "rebuild", false, "cli");
    const controller = new AbortController();
    f.input.options = { signal: controller.signal };
    const checkpoint = t.mock.method(f.input.store, "get", async () => undefined);
    const failure = new Error("offline installation failure");
    let release!: (launch: Launch) => void;
    let reject!: (error: Error) => void;
    let entered!: () => void;
    const gate = new Promise<Launch>((resolve, rejectPromise) => { release = resolve; reject = rejectPromise; });
    const resolving = new Promise<void>((resolve) => { entered = resolve; });
    const driver = new Driver(async () => { entered(); return gate; });
    const settled = driver.prepareSession(f.input).then(value => ({ value }), error => ({ error }));
    t.after(async () => { release({ executable: process.execPath, args: [] }); await settled; });

    await resolving;
    if (outcome === "failed") reject(failure);
    else {
      if (outcome === "aborted") controller.abort(new Error("cancel cross-driver installation"));
      else f.input.session.beginPreparation();
      release({ executable: process.execPath, args: [] });
    }
    const result = await settled;

    assert.ok("error" in result);
    if (outcome === "failed") assert.equal(result.error, failure);
    else assert.match(String(result.error), outcome === "aborted" ? /cancel cross-driver installation/ : /superseded/);
    assert.equal(checkpoint.mock.callCount(), 0);
    assert.equal(f.decide.mock.callCount(), 0);
    assert.equal(f.abort.mock.callCount(), 0);
    assert.equal(f.close.mock.callCount(), 0);
    assert.equal(f.start.mock.callCount(), 0);
    assert.equal(f.input.session.activeProcess, f.runtime);
    assert.equal(f.input.session.driverId, "cli");
  });
}
