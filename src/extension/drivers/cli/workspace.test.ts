import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { BridgeIPC } from "../../bridge/ipc.ts";
import { LiveSession, PiContextAdapter } from "../../session/session.ts";
import { RuntimeSessionStore, RuntimeSessionSync } from "../../session/state.ts";
import { AgyRuntime } from "../../runtime/process.ts";
import { CliDriver } from "./driver.ts";
import { CliRuntimeSession } from "./runtime.ts";

for (const row of [
  { name: "same-workspace live reuse", persisted: false, changed: false, legacy: false, action: "continue" },
  { name: "changed-workspace live rebuild", persisted: false, changed: true, legacy: false, action: "rebuild" },
  { name: "changed-workspace checkpoint rebuild", persisted: true, changed: true, legacy: false, action: "rebuild" },
  { name: "legacy checkpoint rebuild", persisted: true, changed: false, legacy: true, action: "rebuild" },
  { name: "matching-workspace checkpoint resume", persisted: true, changed: false, legacy: false, action: "resume" },
] as const) {
  test(row.name, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-cli-workspace-"));
    const sessions: LiveSession[] = [];
    t.after(async () => {
      try {
        await Promise.all(sessions.map((session) => session.dispose()));
      } finally {
        t.mock.restoreAll();
        await rm(directory, { recursive: true, force: true });
      }
    });
    const executable = path.join(directory, "agy");
    await writeFile(executable, '#!/bin/sh\n[ "$1" = "--version" ] || exit 1\necho 1.2.14\n', { mode: 0o755 });
    const driver = new CliDriver();
    t.mock.method(driver, "detectExecutable", () => executable);
    t.mock.method(driver, "installPlugin", async () => {});
    t.mock.method(BridgeIPC.prototype, "start", async function (this: BridgeIPC) {
      (this as unknown as { socketPath: string }).socketPath = path.join(directory, "bridge.sock");
    });
    const close = t.mock.method(BridgeIPC.prototype, "close", async () => {});
    const abort = t.mock.method(AgyRuntime.prototype, "abort", async function (this: AgyRuntime) {
      Object.defineProperty(this, "isRunning", { configurable: true, value: false });
    });
    const start = t.mock.method(AgyRuntime.prototype, "start", async function (this: AgyRuntime) {
      Object.defineProperty(this, "isRunning", { configurable: true, value: true });
      return { event: "init", conversation_id: this.options.conversationId ?? `new-${start.mock.callCount() + 1}` } as Awaited<ReturnType<AgyRuntime["start"]>>;
    });
    const adapter = new PiContextAdapter();
    const id = adapter.bind(SessionManager.inMemory(directory));
    const store = new RuntimeSessionStore(adapter);
    const sync = new RuntimeSessionSync();
    const original = new LiveSession(id);
    sessions.push(original);
    const model = { id: "test-model" } as Model<any>;
    const prepare = (session: LiveSession, cwd: string) => driver.prepareSession({
      cwd, model, context: { messages: [] }, tools: [], options: undefined,
      session, store, sync, preparationId: session.beginPreparation(),
    });
    const workspace = path.join(directory, "project");
    await Promise.all([workspace, path.join(directory, "other-project")].map((cwd) => mkdir(cwd)));
    const first = await prepare(original, workspace);
    assert.ok(first.proc instanceof CliRuntimeSession);
    assert.equal(first.proc.options.cwd, workspace);
    assert.equal(first.reconstructContext, true);
    sync.record(original, []);
    let target = original;
    if (row.persisted) {
      await store.set(id, {
        sessionId: original.conversationId!,
        ...(!row.legacy ? { compatibilityKey: first.proc.compatibilityKey! } : {}),
      }, [], undefined, driver.sessionVersion);
      await original.dispose();
      target = new LiveSession(id);
      sessions.push(target);
    }
    const startsBefore = start.mock.callCount();
    const abortsBefore = abort.mock.callCount();
    const closesBefore = close.mock.callCount();
    const requestedCwd = row.changed ? path.join(directory, "other", "..", "other-project") : workspace;

    const result = await prepare(target, requestedCwd);

    assert.equal(result.proc.options.cwd, path.resolve(requestedCwd));
    assert.equal(target.activeProcess, result.proc);
    assert.equal(target.activeMcpServer, result.mcpServer);
    assert.equal(target.compatibilityKey, result.proc.compatibilityKey);
    assert.equal(result.reconstructContext, row.action === "rebuild");
    assert.equal(start.mock.callCount() - startsBefore, row.action === "continue" ? 0 : 1);
    if (row.action === "continue") {
      assert.equal(result.proc, first.proc);
      assert.equal(result.mcpServer, first.mcpServer);
    } else {
      assert.notEqual(result.proc, first.proc);
      assert.notEqual(result.mcpServer, first.mcpServer);
      assert.equal(result.proc.options.conversationId, row.action === "resume" ? "new-1" : undefined);
      assert.equal(target.conversationId, row.action === "resume" ? "new-1" : "new-2");
    }
    assert.equal(abort.mock.callCount() - abortsBefore, !row.persisted && row.changed ? 1 : 0);
    assert.equal(close.mock.callCount() - closesBefore, !row.persisted && row.changed ? 1 : 0);
    if (!row.persisted && row.changed) assert.equal(first.proc.isRunning, false);
  });
}
