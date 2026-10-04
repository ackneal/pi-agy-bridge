import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { AgyRuntime } from "../runtime/process.ts";
import { AgyBridge, registerAgyProvider, resolveModelAndEffort, streamAgyProvider } from "./provider.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
        error: `Unsupported AGY reasoning effort: ${effort}. Supported values: low, medium, high.`,
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

for (const modelId of ["claude-sonnet-4-6", "claude-opus-4-6-thinking"]) {
  for (const option of ["reasoningEffort", "reasoning", "thinkingLevel"]) {
    for (const effort of ["low", "medium", "high"]) {
      test(`rejects fixed ${modelId} ${option}=${effort} before runtime preparation`, async (t) => {
        const bridge = new AgyBridge({} as ExtensionAPI);
        const runtimeLookup = t.mock.method(bridge.runtimeSessionStore, "get", async () => {
          throw new Error("Runtime preparation must not begin");
        });
        const model = { id: modelId, provider: "agy", thinkingLevelMap: allNullThinkingLevels } as Model<any>;
        const stream = streamAgyProvider(model, { messages: [], tools: [] }, {
          sessionId: "validation-test", [option]: effort,
        }, undefined, bridge);
        const message = await stream.result();

        assert.equal(message.stopReason, "error");
        assert.equal(message.errorMessage, `Unsupported AGY reasoning effort for ${modelId}: ${effort}.`);
        assert.equal(runtimeLookup.mock.callCount(), 0);
      });
    }
  }
}

test("doctor reports installation errors without starting a model turn", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agy-doctor-command-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let handler: (() => Promise<void>) | undefined;
  const sendMessage = t.mock.fn();
  const pi = {
    on: () => {},
    registerProvider: () => {},
    registerCommand: (name: string, command: { handler: () => Promise<void> }) => {
      assert.equal(name, "agy-bridge:doctor");
      handler = command.handler;
    },
    sendMessage,
  } as unknown as ExtensionAPI;
  const pluginDir = path.join(directory, "missing-plugin");
  const bridge = new AgyBridge(pi, { models: [], agyPath: "__invalid_binary_name__", pluginDir });
  bridge.start();
  await assert.rejects(bridge.ensureAgyPluginInstalled(pluginDir), /manifest not found/);

  assert.ok(handler);
  await handler();

  assert.equal(sendMessage.mock.callCount(), 1);
  const [message, options] = sendMessage.mock.calls[0]!.arguments;
  assert.equal(message.customType, "pi-agy-bridge:doctor");
  assert.equal(message.display, true);
  assert.match(message.content, /AGY plugin manifest not found/);
  assert.match(message.content, /Authentication/);
  assert.deepEqual(options, { triggerTurn: false });
});

test("doctor clears the recorded installation error after successful installation", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-doctor-recovery-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });
  const pluginDir = path.join(home, "source");
  await mkdir(pluginDir);
  await writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({ name: "doctor-test", version: "1.0.0" }));
  const agyPath = path.join(home, "agy");
  await writeFile(agyPath, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.2.14; else echo "install denied" >&2; exit 7; fi\n', { mode: 0o755 });
  let handler: (() => Promise<void>) | undefined;
  const sendMessage = t.mock.fn();
  const pi = {
    on: () => {}, registerProvider: () => {}, sendMessage,
    registerCommand: (_name: string, command: { handler: () => Promise<void> }) => { handler = command.handler; },
  } as unknown as ExtensionAPI;
  const bridge = new AgyBridge(pi, { models: [], agyPath, pluginDir });
  bridge.start();
  await assert.rejects(bridge.ensureAgyPluginInstalled(pluginDir), /install denied/);
  assert.ok(handler);
  await handler();
  assert.match(sendMessage.mock.calls[0]!.arguments[0].content, /Last plugin error.*install denied/s);

  await writeFile(agyPath, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.2.14; fi\n');
  await bridge.ensureAgyPluginInstalled(pluginDir);
  await handler();

  const report = sendMessage.mock.calls[1]!.arguments[0].content;
  assert.match(report, /Plugin installed 1.0.0/);
  assert.doesNotMatch(report, /Last plugin error/);
});

test("registers the AGY provider and session lifecycle without starting runtime work", async (t) => {
  const spawn = t.mock.method(cp, "spawn", () => { throw new Error("Registration must not start a process"); });
  const execFile = t.mock.method(cp, "execFile", () => { throw new Error("Registration must not execute a command"); });
  const runtimeStart = t.mock.method(AgyRuntime.prototype, "start", async () => { throw new Error("Registration must not start the runtime"); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  const handlers = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  let provider: Provider | undefined;

  const pi = {
    on: (event: string, handler: unknown) => handlers.set(event, handler),
    registerCommand: (name: string, options: unknown) => commands.set(name, options),
    registerProvider: (registered: Provider) => {
      provider = registered;
    },
  } as unknown as ExtensionAPI;

  registerAgyProvider(pi, { agyPath: "__invalid_binary_name__" });

  assert.ok(commands.has("agy-bridge:doctor"));
  assert.ok(provider);
  assert.equal(provider.id, "agy");
  assert.equal(provider.name, "Antigravity CLI [pi-agy-bridge]");
  assert.equal(provider.baseUrl, "agy");
  assert.ok(provider.auth.apiKey);
  assert.equal(provider.auth.apiKey.login, undefined);
  assert.ok(provider.auth.oauth);
  assert.equal(provider.auth.oauth.isSubscription, true);
  assert.equal(typeof provider.auth.oauth.login, "function");
  assert.equal(typeof provider.auth.oauth.refresh, "function");
  assert.equal(typeof provider.auth.oauth.toAuth, "function");
  assert.equal(typeof provider.auth.apiKey.check, "function");
  assert.equal(typeof provider.auth.apiKey.resolve, "function");
  const persisted = { type: "api_key" as const, env: { AGY_BRIDGE_ENABLED: "1" } };
  const catalog = provider.getModels();
  assert.deepEqual(provider.filterModels?.(catalog, persisted), catalog);
  assert.deepEqual(provider.filterModels?.(catalog, undefined), []);
  assert.ok(Array.isArray(provider.getModels()));
  assert.equal(typeof provider.refreshModels, "function");
  assert.equal(typeof provider.streamSimple, "function");
  assert.equal(typeof handlers.get("session_start"), "function");
  assert.equal(typeof handlers.get("session_shutdown"), "function");

  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(execFile.mock.callCount(), 0);
  assert.equal(runtimeStart.mock.callCount(), 0);

  const shutdown = handlers.get("session_shutdown") as (() => Promise<void>);
  await shutdown();
});

test("explicit AGY models are native static models preserving configured fields", () => {
  let provider: Provider | undefined;
  const configured = {
    id: "custom", name: "Custom", reasoning: true, input: ["text"] as ("text" | "image")[],
    contextWindow: 12345, maxTokens: 678,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  };
  registerAgyProvider({
    on: () => {}, registerCommand: () => {},
    registerProvider: (registered: Provider) => { provider = registered; },
  } as unknown as ExtensionAPI, { models: [configured], agyPath: "__invalid_binary_name__" });

  assert.ok(provider);
  assert.equal(provider.refreshModels, undefined);
  assert.deepEqual(provider.getModels(), [{
    ...configured, api: "agy", provider: "agy", baseUrl: "agy", type: "chat",
  }]);
});
