import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { BridgeIPC } from "../../bridge/ipc.ts";
import { LiveSession, PiContextAdapter } from "../../session/session.ts";
import { RuntimeSessionStore, RuntimeSessionSync } from "../../session/state.ts";
import { AgyRuntime } from "../../runtime/process.ts";
import { Driver } from "./driver.ts";
import { RuntimeSession } from "./runtime.ts";
import { SessionMode } from "../types.ts";
import { prepareSystemMessages } from "../../provider/context-prompt.ts";
import { prepareRuntime, resolveModelAndEffort } from "./session.ts";

describe("resolveModelAndEffort", () => {
  const allNullThinkingLevels = {
    off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null,
  };

  type ResolverCase = {
    name: string;
    modelId: string;
    options?: Record<string, string> | undefined;
    thinkingLevelMap?: Model<any>["thinkingLevelMap"];
    expected?: ReturnType<typeof resolveModelAndEffort>;
    error?: string;
  };

  const resolverCases: ResolverCase[] = [
    { name: "Gemini has no default effort", modelId: "gemini-3.8-flash", expected: { baseModel: "gemini-3.8-flash", effort: undefined } },
    { name: "explicit effort overrides suffix", modelId: "gemini-3.8-flash-low", options: { reasoningEffort: "high" }, expected: { baseModel: "gemini-3.8-flash", effort: "high" } },
    ...["reasoningEffort", "reasoning", "thinkingLevel"].flatMap((option) => [
      ...["off", "minimal", "xhigh", "max", "unknown", ""].flatMap((effort) =>
        ["other-model", "other-model-high"].map((modelId) => ({
          name: `rejects ${option}=${JSON.stringify(effort)} for ${modelId}`, modelId, options: { [option]: effort },
          error: `Unsupported Antigravity CLI reasoning effort: ${effort}. Supported values: low, medium, high.`,
        }))),
      ...(["low", "medium", "high"] as const).flatMap((effort) =>
        ["other-model", "other-model-low"].map((modelId) => ({
          name: `accepts ${option}=${effort} for ${modelId}`, modelId, options: { [option]: effort },
          expected: { baseModel: "other-model", effort },
        }))),
    ]),
    ...([
      ["other-model", "other-model", undefined],
      ["other-model-low", "other-model", "low"],
      ["other-model-medium", "other-model", "medium"],
      ["other-model-HIGH", "other-model", "high"],
    ] as const).flatMap(([modelId, baseModel, effort]) => [undefined, {}].map((options) => ({
      name: `absent effort for ${modelId} with ${JSON.stringify(options)}`, modelId, options, expected: { baseModel, effort },
    }))),
    ...["claude-sonnet-4-6", "claude-opus-4-6-thinking"].flatMap((modelId) => [undefined, {}].map((options) => ({
      name: `fixed ${modelId} with ${JSON.stringify(options)}`, modelId, options, thinkingLevelMap: allNullThinkingLevels,
      expected: { baseModel: modelId, effort: undefined },
    }))),
    ...(["low", "medium", "high"] as const).map((effort) => ({
      name: `supported Gemini ${effort}`, modelId: "gemini-3.8-flash", options: { reasoning: effort },
      thinkingLevelMap: { ...allNullThinkingLevels, low: "low", medium: "medium", high: "high" },
      expected: { baseModel: "gemini-3.8-flash", effort },
    })),
  ];

  for (const row of resolverCases) {
    test(row.name, () => {
      const resolve = () => resolveModelAndEffort(row.modelId, row.options as SimpleStreamOptions, row.thinkingLevelMap);
      if (row.error) assert.throws(resolve, { message: row.error });
      else assert.deepEqual(resolve(), row.expected);
    });
  }
});

describe("prepareRuntime cancellation and lifecycle", () => {
  for (const stage of ["before lookup", "after lookup"] as const) {
    for (const reason of ["abort", "supersede"] as const) {
      test(`preparation rejects ${reason} ${stage} before sync or installation`, async () => {
        const session = new LiveSession("cli-preparation");
        const preparationId = session.beginPreparation();
        const controller = new AbortController();
        const cancellation = new Error("test cancellation");
        const calls: string[] = [];
        const invalidate = () => {
          if (reason === "abort") controller.abort(cancellation);
          else session.beginPreparation();
        };
        if (stage === "before lookup") invalidate();

        try {
          await assert.rejects(prepareRuntime(
            { id: "test-model" } as Model<any>,
            { messages: [] },
            [],
            { signal: controller.signal },
            process.cwd(),
            {
              store: {
                get: async () => {
                  calls.push("get");
                  invalidate();
                  return undefined;
                },
                delete: async () => { calls.push("delete"); },
              },
              sync: {
                decide: () => { throw new Error("sync must not run"); },
              },
              sessionVersion: "cli:v1",
              installPlugin: async () => { calls.push("install"); },
            },
            session,
            resolveModelAndEffort("test-model"),
            preparationId,
          ), reason === "abort" ? cancellation : {
            message: "Antigravity CLI runtime preparation was superseded",
          });
          assert.deepEqual(calls, stage === "before lookup" ? [] : ["get"]);
          assert.equal(session.activeProcess, null);
          assert.equal(session.activeMcpServer, null);
        } finally {
          await session.dispose();
        }
      });
    }
  }
});

describe("prepareRuntime workspace and session reuse", () => {
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
      const driver = new Driver();
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
      const context = { messages: [] };
      const prepare = (session: LiveSession) => driver.prepareSession({
        model, context, messages: prepareSystemMessages(context), tools: [], options: undefined,
        session, store, sync, preparationId: session.beginPreparation(),
        mode: SessionMode.Conversation,
      });
      const first = await prepare(original);
      assert.ok(first.proc instanceof RuntimeSession);
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
});
