import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
  { name: "default dedicated cwd", persisted: false, changed: false, legacy: false, action: "continue", home: "default" },
  { name: "home-expanded dedicated cwd", persisted: false, changed: false, legacy: false, action: "continue", home: "tilde" },
  { name: "same-runtime-cwd live reuse", persisted: false, changed: false, legacy: false, action: "continue" },
  { name: "changed-runtime-cwd live rebuild", persisted: false, changed: true, legacy: false, action: "rebuild" },
  { name: "changed-runtime-cwd checkpoint rebuild", persisted: true, changed: true, legacy: false, action: "rebuild" },
  { name: "legacy checkpoint rebuild", persisted: true, changed: false, legacy: true, action: "rebuild" },
  { name: "matching-runtime-cwd checkpoint resume", persisted: true, changed: false, legacy: false, action: "resume" },
] as const) {
  test(row.name, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-cli-workspace-"));
    const sessions: LiveSession[] = [];
    t.mock.method(os, "homedir", () => directory);
    const home = "home" in row ? row.home : "custom";
    const geminiHome = path.join(directory, home === "default" ? ".gemini" : "gemini");
    const previousHome = process.env.GEMINI_HOME;
    t.after(() => {
      if (previousHome === undefined) delete process.env.GEMINI_HOME;
      else process.env.GEMINI_HOME = previousHome;
    });
    if (home === "default") delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = home === "tilde" ? "~/gemini" : geminiHome;
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
    const prepare = (session: LiveSession) => driver.prepareSession({
      model, context: { messages: [] }, tools: [], options: undefined,
      session, store, sync, preparationId: session.beginPreparation(),
    });
    const first = await prepare(original);
    assert.ok(first.proc instanceof CliRuntimeSession);
    assert.equal(first.proc.options.cwd, path.join(geminiHome, "antigravity-cli"));
    assert.ok((await stat(first.proc.options.cwd!)).isDirectory());
    assert.equal(first.reconstructContext, true);
    sync.record(original, []);
    let target = original;
    if (row.persisted) {
      await store.set(id, {
        sessionId: original.conversationId!,
        ...(!row.legacy ? { compatibilityKey: first.proc.compatibilityKey! } : {}),
      }, [], driver.sessionVersion);
      await original.dispose();
      target = new LiveSession(id);
      sessions.push(target);
    }
    const startsBefore = start.mock.callCount();
    const abortsBefore = abort.mock.callCount();
    const closesBefore = close.mock.callCount();
    const requestedHome = row.changed ? path.join(directory, "other", "..", "other-gemini") : geminiHome;
    process.env.GEMINI_HOME = requestedHome;

    const result = await prepare(target);

    assert.equal(result.proc.options.cwd, path.resolve(requestedHome, "antigravity-cli"));
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
