import { prepareSystemMessages } from "../../provider/context-prompt.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path, { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
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
import { useExecutable } from "./executable-fixture.ts";
import { composeSystemPrompt } from "./instructions.ts";
import type { Launch } from "./installation.ts";
import { prepareRuntime } from "./prepare.ts";
import { RuntimeSession } from "./runtime.ts";

describe("prepareRuntime lifecycle and cancellation", () => {
  test("ACP clears the previous driver once before checkpoint lookup", async (t) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agy-acp-prepare-"));
    const previousHome = process.env.GEMINI_HOME;
    process.env.GEMINI_HOME = home;
    t.after(async () => {
      if (previousHome === undefined) delete process.env.GEMINI_HOME;
      else process.env.GEMINI_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    });
    const live = new LiveSession("test");
    t.after(() => live.dispose());
    const previous = new CliRuntimeSession({ agentName: "pi-bridge", model: "raw" }, new Set(), {});
    live.setSession(previous, "previous-sync");
    const abort = t.mock.method(previous, "abort", async () => {});
    const driver = new Driver();
    useExecutable(t, process.execPath);
    const dispose = t.mock.method(live, "dispose", live.dispose.bind(live));
    const stopped = new Error("Stopped at checkpoint lookup");
    const get = t.mock.fn(async () => {
      assert.equal(dispose.mock.callCount(), 1);
      assert.equal(live.activeProcess, null);
      throw stopped;
    });

    await assert.rejects(driver.prepareSession({
      model: { id: "raw" } as Parameters<typeof prepareRuntime>[0],
      context: { messages: [] }, messages: prepareSystemMessages({ messages: [] }), mode: SessionMode.Conversation, tools: [], options: undefined, session: live,
      store: { get, delete: async () => {} }, sync: new RuntimeSessionSync(),
      preparationId: live.beginPreparation(),
    }), (error) => error === stopped);

    assert.equal(get.mock.callCount(), 1);
    assert.equal(dispose.mock.callCount(), 1);
    assert.equal(abort.mock.callCount(), 1);
  });

  test("superseded ACP preparation stops before checkpoint or resource acquisition", async () => {
    const live = new LiveSession("test");
    const stale = live.beginPreparation();
    live.beginPreparation();
    let reads = 0;

    await assert.rejects(prepareRuntime({ id: "raw" } as Parameters<typeof prepareRuntime>[0], { messages: [] }, [], [], undefined, { cwd: process.cwd(), resolve: async () => { throw new Error("Superseded preparation must not resolve installation"); } }, {
      store: { get: async () => { reads++; return undefined; }, delete: async () => {} }, sync: new RuntimeSessionSync(), sessionVersion: "acp:v1",
    }, live, stale), /superseded/);

    assert.equal(reads, 0);
    assert.equal(live.activeProcess, null);
  });
});

describe("prepareRuntime installation reuse and recovery", () => {
  async function createLiveRuntimeFixture(t: TestContext, action: "continue" | "resume" | "rebuild", pendingTools = false, backend: "acp" | "cli" = "acp") {
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
      model, context, messages, mode: SessionMode.Conversation, tools: [], options: undefined, session, preparationId, sync,
      store: { get: async () => undefined, delete: async () => {} },
    };
    return { input, runtime, mcp, abort, close, start, decide };
  }

  for (const row of [
    { name: "reuses a compatible running process without resolving installation", action: "continue", pendingTools: false },
    { name: "continues pending tools without resolving installation despite changed signatures", action: "continue", pendingTools: true },
    { name: "resolves installation before resuming a stopped process", action: "resume", pendingTools: false },
    { name: "resolves installation before rebuilding an incompatible process", action: "rebuild", pendingTools: false },
  ] as const) {
    test(`ACP installation resolution: ${row.name}`, async (t) => {
      const f = await createLiveRuntimeFixture(t, row.action, row.pendingTools);
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
      const f = await createLiveRuntimeFixture(t, "rebuild");
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
      const f = await createLiveRuntimeFixture(t, "rebuild", false, "cli");
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
});

describe("prepareRuntime loaded model failure and cleanup", () => {
  function barrier() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  }

  for (const scenario of ["rebuild", "cleanup failure", "cancel"] as const) {
    test(`loaded ACP model failure: ${scenario}`, async t => {
      const dir = await mkdtemp(join(tmpdir(), "resume-cleanup-"));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const log = join(dir, "events");
      const live = new LiveSession("cleanup-test");
      const controller = new AbortController();
      const entered = barrier();
      const gate = barrier();
      const abortEntered = barrier();
      const abortGate = barrier();
      t.after(async () => {
        gate.release();
        abortGate.release();
        await live.dispose();
        await rm(dir, { recursive: true, force: true });
      });
      const events = async (): Promise<{ event: string; pid: number }[]> =>
        (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      let bridge: BridgeIPC | undefined;
      let failed: RuntimeSession | undefined;
      let starts = 0;
      let deletes = 0;
      const close = BridgeIPC.prototype.close;
      const abort = RuntimeSession.prototype.abort;
      t.mock.method(BridgeIPC.prototype, "start", async function (this: BridgeIPC) {
        starts++;
        if (starts === 2) {
          assert.equal(live.activeProcess, null);
          assert.equal(live.activeMcpServer, null);
          assert.equal(failed?.isRunning, false);
          assert.throws(() => bridge!.bridgeUri, /not been started/);
          const pid = (await events())[0]!.pid;
          assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        }
        const socketPath = join(dir, `bridge-${starts}.sock`);
        await writeFile(socketPath, "socket acquisition fixture");
        (this as unknown as { socketPath: string }).socketPath = socketPath;
      });
      t.mock.method(BridgeIPC.prototype, "close", async function (this: BridgeIPC) {
        if (!bridge) {
          bridge = this;
          entered.release();
          await gate.promise;
          await close.call(this);
          if (scenario === "cleanup failure") throw new Error("bridge cleanup failed");
          return;
        }
        return close.call(this);
      });
      t.mock.method(RuntimeSession.prototype, "abort", async function (this: RuntimeSession) {
        if (!failed) {
          failed = this;
          abortEntered.release();
          await abortGate.promise;
        }
        await abort.call(this);
      });
      const pending = prepareRuntime({ id: "selected" } as Parameters<typeof prepareRuntime>[0],
        { messages: [] }, [], [], { signal: controller.signal }, {
          cwd: process.cwd(),
          resolve: async () => ({
            executable: process.execPath, cwd: process.cwd(),
            args: ["--experimental-strip-types", fileURLToPath(new URL("./resume-cleanup-fixture.ts", import.meta.url)), log],
          }),
        }, {
          store: { get: async () => undefined, delete: async () => { deletes++; } },
          sync: { decide: () => ({ action: "resume", conversationId: "saved" }) }, sessionVersion: "test",
        }, live, live.beginPreparation());
      const settled = pending.then(value => ({ value }), error => ({ error }));

      await entered.promise;
      assert.deepEqual((await events()).map(entry => entry.event), ["loaded", "model-failed"]);
      assert.equal(starts, 1);
      assert.equal(deletes, 0);
      assert.equal(live.activeProcess, null);
      assert.equal(live.activeMcpServer, null);
      if (scenario === "cancel") controller.abort(new Error("cancel cleanup"));
      gate.release();
      await abortEntered.promise;
      assert.equal(starts, 1);
      assert.equal(deletes, 0);
      abortGate.release();
      const result = await settled;
      if (scenario === "rebuild") {
        assert.ok("value" in result);
        assert.equal(result.value.reconstructContext, true);
        assert.equal(live.activeProcess, result.value.proc);
        assert.equal(live.activeMcpServer, result.value.mcpServer);
        assert.equal(deletes, 1);
        assert.deepEqual((await events()).map(entry => entry.event), ["loaded", "model-failed", "new"]);
      } else {
        assert.ok("error" in result);
        assert.match(String(result.error), scenario === "cancel" ? /cancel cleanup/ : /cleanup failed/);
        assert.equal(starts, 1);
        assert.equal(deletes, 0);
        assert.equal(live.activeProcess, null);
        assert.equal(live.activeMcpServer, null);
      }
    });
  }
});
