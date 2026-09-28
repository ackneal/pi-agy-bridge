import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgyProvider } from "../provider.ts";

test("registers the AGY provider and session lifecycle without starting runtime work", async () => {
  const handlers = new Map<string, unknown>();
  let provider: {
    name: string;
    baseUrl: string;
    apiKey: string;
    models: unknown[];
    streamSimple: unknown;
  } | undefined;

  const pi = {
    on: (event: string, handler: unknown) => handlers.set(event, handler),
    registerProvider: (_name: string, registered: typeof provider) => {
      provider = registered;
    },
  } as unknown as ExtensionAPI;

  registerAgyProvider(pi);

  assert.ok(provider);
  assert.equal(provider.name, "agy");
  assert.equal(provider.baseUrl, "agy");
  assert.equal(provider.apiKey, "not-used");
  assert.ok(provider.models.length > 0);
  assert.equal(typeof provider.streamSimple, "function");
  assert.equal(typeof handlers.get("session_start"), "function");
  assert.equal(typeof handlers.get("session_shutdown"), "function");

  const shutdown = handlers.get("session_shutdown") as (() => Promise<void>);
  await shutdown();
});
