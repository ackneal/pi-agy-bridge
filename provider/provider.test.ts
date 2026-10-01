import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgyBridge, registerAgyProvider, resolveModelAndEffort } from "./provider.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

test("registers the AGY provider and session lifecycle without starting runtime work", async () => {
  const handlers = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
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
    registerCommand: (name: string, options: unknown) => commands.set(name, options),
    registerProvider: (_name: string, registered: typeof provider) => {
      provider = registered;
    },
  } as unknown as ExtensionAPI;

  registerAgyProvider(pi, { agyPath: "__invalid_binary_name__" });

  assert.ok(commands.has("agy-bridge:doctor"));
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
