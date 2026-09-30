import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgyProvider, resolveModelAndEffort } from "./provider.ts";

test("resolves explicit model suffix levels without defaulting Gemini effort", () => {
  assert.deepEqual(resolveModelAndEffort("gemini-3.8-flash"), {
    baseModel: "gemini-3.8-flash",
    effort: undefined,
  });
  assert.deepEqual(resolveModelAndEffort("other-model-high"), {
    baseModel: "other-model",
    effort: "high",
  });
  assert.deepEqual(resolveModelAndEffort("gemini-3.8-flash-low", { reasoningEffort: "high" } as any), {
    baseModel: "gemini-3.8-flash",
    effort: "high",
  });
});

test("registers the AGY provider and session lifecycle without starting runtime work", async () => {
  const handlers = new Map<string, unknown>();
  let provider: {
    name: string;
    baseUrl: string;
    apiKey: string;
    models: unknown[];
    refreshModels?: unknown;
    streamSimple: unknown;
  } | undefined;

  const pi = {
    on: (event: string, handler: unknown) => handlers.set(event, handler),
    registerProvider: (_name: string, registered: typeof provider) => {
      provider = registered;
    },
  } as unknown as ExtensionAPI;

  registerAgyProvider(pi, { agyPath: "__invalid_binary_name__" });

  assert.ok(provider);
  assert.equal(provider.name, "agy");
  assert.equal(provider.baseUrl, "agy");
  assert.equal(provider.apiKey, "not-used");
  assert.ok(Array.isArray(provider.models));
  assert.equal(typeof provider.refreshModels, "function");
  assert.equal(typeof provider.streamSimple, "function");
  assert.equal(typeof handlers.get("session_start"), "function");
  assert.equal(typeof handlers.get("session_shutdown"), "function");

  const shutdown = handlers.get("session_shutdown") as (() => Promise<void>);
  await shutdown();
});
