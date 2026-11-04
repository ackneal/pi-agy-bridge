import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { LiveSession } from "../../session/session.ts";
import { resolveModelAndEffort, prepareRuntime } from "./session.ts";

describe("resolveModelAndEffort", () => {
  test("resolves base model without effort", () => {
    assert.deepEqual(resolveModelAndEffort("gemini-3.8-flash"), {
      baseModel: "gemini-3.8-flash",
      effort: undefined,
    });
  });

  test("resolves effort from suffix", () => {
    assert.deepEqual(resolveModelAndEffort("gemini-3.8-flash-high"), {
      baseModel: "gemini-3.8-flash",
      effort: "high",
    });
  });

  test("explicit option overrides suffix", () => {
    assert.deepEqual(
      resolveModelAndEffort("gemini-3.8-flash-low", { reasoningEffort: "high" } as any),
      {
        baseModel: "gemini-3.8-flash",
        effort: "high",
      }
    );
  });

  test("rejects invalid effort", () => {
    assert.throws(
      () => resolveModelAndEffort("gemini-3.8-flash", { reasoningEffort: "invalid" } as any),
      /Unsupported Antigravity reasoning effort: invalid/
    );
  });
});

describe("prepareRuntime lifecycle", () => {
  test("preparation rejects aborted signal before work begins", async () => {
    const session = new LiveSession("test-prep-abort");
    const preparationId = session.beginPreparation();
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));

    await assert.rejects(
      () =>
        prepareRuntime(
          { id: "gemini-3.8-flash" } as any,
          { messages: [] },
          [],
          [],
          { signal: controller.signal },
          process.cwd(),
          {
            store: { get: async () => undefined, delete: async () => {} },
            sync: { decide: () => ({ action: "rebuild" as const }) },
            sessionVersion: "cli-acp:v1",
            installPlugin: async () => {},
          },
          session,
          { baseModel: "gemini-3.8-flash", effort: undefined },
          preparationId
        ),
      /pre-aborted/
    );
  });

  test("preparation rejects superseded preparationId", async () => {
    const session = new LiveSession("test-prep-supersede");
    const preparationId = session.beginPreparation();
    // Start a new preparation to supersede the first
    session.beginPreparation();

    await assert.rejects(
      () =>
        prepareRuntime(
          { id: "gemini-3.8-flash" } as any,
          { messages: [] },
          [],
          [],
          undefined,
          process.cwd(),
          {
            store: { get: async () => undefined, delete: async () => {} },
            sync: { decide: () => ({ action: "rebuild" as const }) },
            sessionVersion: "cli-acp:v1",
            installPlugin: async () => {},
          },
          session,
          { baseModel: "gemini-3.8-flash", effort: undefined },
          preparationId
        ),
      /Antigravity runtime preparation was superseded/
    );
  });
});
