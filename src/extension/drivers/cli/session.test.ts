import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { LiveSession } from "../../session/session.ts";
import { BridgeIPC } from "../../bridge/ipc.ts";
import { Connection } from "./connection.ts";
import { RuntimeSession } from "./runtime.ts";
import { resolveModelAndEffort, prepareRuntime } from "./session.ts";

describe("resolveModelAndEffort", () => {
  const cases: {
    name: string;
    modelId: string;
    options?: SimpleStreamOptions;
    thinkingLevelMap?: Model<any>["thinkingLevelMap"];
    expected?: ReturnType<typeof resolveModelAndEffort>;
    error?: RegExp;
  }[] = [
    { name: "base model without effort", modelId: "gemini-3.8-flash", expected: { baseModel: "gemini-3.8-flash", effort: undefined } },
    { name: "suffix effort", modelId: "gemini-3.8-flash-high", expected: { baseModel: "gemini-3.8-flash", effort: "high" } },
    { name: "case-insensitive suffix", modelId: "gemini-3.8-flash-HIGH", expected: { baseModel: "gemini-3.8-flash", effort: "high" } },
    ...["reasoningEffort", "reasoning", "thinkingLevel"].flatMap((key) => [
      { name: `${key} overrides suffix`, modelId: "gemini-3.8-flash-low", options: { [key]: "high" } as SimpleStreamOptions, expected: { baseModel: "gemini-3.8-flash", effort: "high" as const } },
      { name: `invalid ${key}`, modelId: "gemini-3.8-flash", options: { [key]: "invalid" } as SimpleStreamOptions, error: /Unsupported Antigravity reasoning effort: invalid/ },
    ]),
    { name: "model rejects explicit effort", modelId: "fixed-model", options: { reasoning: "high" }, thinkingLevelMap: { high: null }, error: /Unsupported Antigravity reasoning effort for fixed-model: high/ },
    { name: "model rejects suffix effort", modelId: "fixed-model-high", thinkingLevelMap: { high: null }, error: /Unsupported Antigravity reasoning effort for fixed-model-high: high/ },
  ];

  for (const row of cases) {
    test(row.name, () => {
      const resolve = () => resolveModelAndEffort(row.modelId, row.options, row.thinkingLevelMap);
      if (row.error) assert.throws(resolve, row.error);
      else assert.deepEqual(resolve(), row.expected);
    });
  }
});

describe("prepareRuntime reuse", () => {
  for (const row of [
    { name: "matching model and effort", requested: "active-model-high", expected: "active-model-high" },
    { name: "model change deferred across pending turn", requested: "other-model-high", expected: "active-model" },
    { name: "effort change deferred across pending turn", requested: "active-model-low", expected: "active-model" },
  ]) {
    test(row.name, async () => {
      const session = new LiveSession("cli-reuse");
      const preparationId = session.beginPreparation();
      const connection = new Connection({ executable: "unused", cwd: process.cwd() });
      const proc = new RuntimeSession(connection, { cwd: process.cwd(), model: "active-model", effort: "high" });
      const bridge = new BridgeIPC([], session.id, session.resources);
      session.setSession(proc, "previous-sync-key", bridge, "existing-conversation", preparationId);

      try {
        const result = await prepareRuntime(
          { id: row.requested } as Model<any>,
          { messages: [] },
          [],
          [],
          undefined,
          process.cwd(),
          {
            store: { get: async () => undefined, delete: async () => { throw new Error("must not delete"); } },
            sync: { decide: () => ({ action: "continue" }) },
            sessionVersion: "cli:v1",
            installPlugin: async () => { throw new Error("must not install"); },
          },
          session,
          resolveModelAndEffort(row.requested),
          preparationId,
        );
        assert.equal(result.proc, proc);
        assert.equal(result.mcpServer, bridge);
        assert.equal(result.reconstructContext, false);
        assert.equal(result.modelId, row.expected);
      } finally {
        await session.dispose();
      }
    });
  }
});

describe("prepareRuntime lifecycle", () => {
  for (const stage of ["before lookup", "after lookup"] as const) {
    for (const reason of ["abort", "supersede"] as const) {
      test(`rejects ${reason} ${stage} before sync or installation`, async () => {
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
              sync: { decide: () => { throw new Error("sync must not run"); } },
              sessionVersion: "cli:v1",
              installPlugin: async () => { calls.push("install"); },
            },
            session,
            { baseModel: "test-model", effort: undefined },
            preparationId,
          ), reason === "abort" ? cancellation : {
            message: "Antigravity runtime preparation was superseded",
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
