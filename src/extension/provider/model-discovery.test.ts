import { useAuthHomeFixture } from "./auth-home-fixture.ts";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test, { describe, type TestContext } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { SessionManager, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider, Model, Context, AssistantMessage, AssistantMessageEvent, ModelsPublication } from "@earendil-works/pi-ai";
import { AgyRuntime } from "../runtime/process.ts";
import { BridgeIPC } from "../bridge/ipc.ts";
import { Driver as CliDriver } from "../drivers/cli/driver.ts";
import { RuntimeSession as CliRuntimeSession } from "../drivers/cli/runtime.ts";
import { calculateSyncKey } from "../session/session.ts";
import { Driver as AcpDriver } from "../drivers/acp/driver.ts";
import { Connection as AcpConnection } from "../drivers/acp/connection.ts";
import { useExecutable } from "../drivers/acp/executable-fixture.ts";
import { parseModelsOutput } from "../discovery/models.ts";
import { prepareDriverCwd } from "../drivers/cwd.ts";
import type { AgyInput } from "../shared/types.ts";
import { Bridge, streamProvider } from "./provider.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

useAuthHomeFixture();

describe("driver-scoped model cache restoration", () => {
  for (const driver of ["cli", "acp"] as const) {
    for (const tag of [undefined, "cli", "acp"] as const) {
      test(`${driver} restores model cache with ${tag ?? "no"} driver tag`, async () => {
        let provider!: Provider;
        const bridge = new Bridge({
          on: () => {}, registerCommand: () => {},
          registerProvider: (registered: Provider) => { provider = registered; },
        } as unknown as ExtensionAPI, driver === "cli" ? new CliDriver() : new AcpDriver());
        bridge.start();
        const models = parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)")
          .map((model) => tag === undefined ? model : { ...model, agyDriver: tag });

        await provider.refreshModels!({
          stored: { models }, allowNetwork: false, signal: new AbortController().signal,
          publish: async (publication) => { publication.update?.(); return true; },
        });

        assert.equal(provider.getModels()[0]?.id, "gemini-3.8-flash");
        assert.equal(bridge.driver.id, driver);
      });
    }
  }

  test("new ACP session restores a legacy cached scoped model without network or login", async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-legacy-scope-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const authPath = path.join(directory, "auth.json");
    await writeFile(authPath, JSON.stringify({ agy: { type: "api_key", env: { AGY_BRIDGE_ENABLED: "1" } } }));
    const options = { authPath, modelsPath: path.join(directory, "models.json"), refreshOnCreate: false };
    const runtime = await ModelRuntime.create(options);
    const bridge = new Bridge({
      on: () => {}, registerCommand: () => {},
      registerProvider: runtime.registerNativeProvider.bind(runtime),
    } as unknown as ExtensionAPI, new CliDriver());
    bridge.start();
    await runtime.refresh({ providers: ["agy"], allowNetwork: false });
    t.mock.method(bridge.driver, "discoverModels", async () => parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)"));
    await runtime.refresh({ providers: ["agy"], allowNetwork: true });

    const reopened = await ModelRuntime.create(options);
    const acpBridge = new Bridge({
      on: () => {}, registerCommand: () => {},
      registerProvider: reopened.registerNativeProvider.bind(reopened),
    } as unknown as ExtensionAPI, new AcpDriver());
    const discovery = t.mock.method(acpBridge.driver, "discoverModels", async () => { throw new Error("Offline restore must not discover models"); });
    acpBridge.start();
    await reopened.refresh({ providers: ["agy"], allowNetwork: false });

    assert.ok(reopened.getModel("agy", "gemini-3.8-flash"));
    assert.equal(discovery.mock.callCount(), 0);
    assert.equal(acpBridge.driver.id, "acp");
  });

  for (const allowNetwork of [false, true]) {
    test(`ACP scoped models remain available without cache or login: network=${allowNetwork}`, async (t) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "agy-noauth-scope-"));
      const previousHome = process.env.GEMINI_HOME;
      process.env.GEMINI_HOME = directory;
      t.after(async () => {
        if (previousHome === undefined) delete process.env.GEMINI_HOME;
        else process.env.GEMINI_HOME = previousHome;
        await rm(directory, { recursive: true, force: true });
      });
      const authPath = path.join(directory, "auth.json");
      await writeFile(authPath, JSON.stringify({ agy: { type: "api_key", env: { AGY_BRIDGE_ENABLED: "1" } } }));
      const runtime = await ModelRuntime.create({ authPath, modelsPath: path.join(directory, "models.json"), refreshOnCreate: false });
      const start = t.mock.method(AcpConnection.prototype, "start", async () => ({ protocolVersion: acp.PROTOCOL_VERSION }));
      t.mock.method(AcpConnection.prototype, "request", async () => { throw acp.RequestError.authRequired(); });
      const bridge = new Bridge({
        on: () => {}, registerCommand: () => {},
        registerProvider: runtime.registerNativeProvider.bind(runtime),
      } as unknown as ExtensionAPI, new AcpDriver());
      useExecutable(t, process.execPath);
      bridge.start();
      await runtime.refresh({ providers: ["agy"], allowNetwork: false });

      await runtime.refresh({ providers: ["agy"], allowNetwork });

      assert.equal(bridge.driver.id, "acp");
      assert.ok(runtime.getModel("agy", "gemini-3.8-flash"));
      assert.ok(runtime.getModel("agy", "gemini-3.1-pro"));
      assert.equal(start.mock.callCount(), allowNetwork ? 1 : 0);
    });
  }

});
describe("CLI catalog discovery and persistence", () => {
  for (const scenario of [
    { name: "cache-only restore", allowNetwork: false, accept: true, fail: false, aborted: false, expected: "claude-sonnet-4-6", publishes: 0 },
    { name: "successful discovery", allowNetwork: true, accept: true, fail: false, aborted: false, expected: "gemini-3.8-flash", publishes: 1 },
    { name: "rejected stale publication", allowNetwork: true, accept: false, fail: false, aborted: false, expected: "claude-sonnet-4-6", publishes: 1 },
    { name: "failed discovery retains cache", allowNetwork: true, accept: true, fail: true, aborted: false, expected: "claude-sonnet-4-6", publishes: 0 },
    { name: "aborted refresh skips work", allowNetwork: true, accept: true, fail: false, aborted: true, expected: undefined, publishes: 0 },
  ]) {
    test(`native Antigravity CLI catalog: ${scenario.name}`, async (t) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "agy-catalog-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const agyPath = path.join(directory, "agy");
      await writeFile(agyPath, scenario.fail
        ? '#!/bin/sh\nexit 7\n'
        : '#!/bin/sh\ncase " $* " in *" --input-format "*) printf \'{"event":"init"}\\n\'; while :; do sleep 1; done;; esac\nprintf "gemini-3.8-flash-high  Gemini 3.8 Flash (High)\\n"\n', { mode: 0o755 });
      let provider: Provider | undefined;
      const pi = {
        on: () => {}, registerCommand: () => {},
        registerProvider: (registered: Provider) => { provider = registered; },
      } as unknown as ExtensionAPI;
      t.mock.method(CliDriver.prototype, "detectExecutable", () => agyPath);
      t.mock.method(CliDriver.prototype, "discoverModels", async () => {
        if (scenario.fail) throw new Error("discovery failed");
        return parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)");
      });
      new Bridge(pi, new CliDriver()).start();
      assert.ok(provider?.refreshModels);
      const publications: ModelsPublication[] = [];
      const controller = new AbortController();
      if (scenario.aborted) controller.abort();
      const restored = parseModelsOutput("claude-sonnet-4-6  Claude Sonnet 4.6 (Thinking)");

      const result = await provider.refreshModels({
        stored: { models: restored }, allowNetwork: scenario.allowNetwork, signal: controller.signal,
        publish: async (publication) => {
          if (publication.persist) publications.push(publication);
          const accepted = !publication.persist || scenario.accept;
          if (accepted) publication.update?.();
          return accepted;
        }
      });

      assert.equal(result, undefined);
      assert.equal(provider.getModels()[0]?.id, scenario.expected);
      assert.equal(publications.length, scenario.publishes);
      if (scenario.publishes) {
        const persisted = publications[0]?.persist?.models[0];
        assert.equal(persisted?.provider, "agy");
        assert.equal(persisted?.api, "agy");
        assert.equal(persisted?.baseUrl, "agy");
        assert.equal(persisted?.id, "gemini-3.8-flash");
        assert.ok(persisted && "maxTokens" in persisted);
        assert.equal(persisted.maxTokens, 65536);
        assert.deepEqual(persisted?.cost, { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 });
      }
    });
  }

  async function registerAndAwaitRefresh(t: TestContext, runtime: ModelRuntime, register: () => void): Promise<void> {
    const refresh = runtime.refresh.bind(runtime);
    let registrationRefresh: ReturnType<ModelRuntime["refresh"]> | undefined;
    const mockedRefresh = t.mock.method(runtime, "refresh", (...args: Parameters<ModelRuntime["refresh"]>) => {
      registrationRefresh = refresh(...args);
      return registrationRefresh;
    });
    try {
      register();
      assert.ok(registrationRefresh, "provider registration must start an offline refresh");
      await registrationRefresh;
    } finally {
      mockedRefresh.mock.restore();
    }
  }

  test("Pi persists raw Antigravity CLI discovery and reapplies models.json overrides after restore", async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-native-store-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const modelsPath = path.join(directory, "models.json");
    const agyPath = path.join(directory, "agy");
    await writeFile(modelsPath, JSON.stringify({ providers: { agy: {
      modelOverrides: { "gemini-3.8-flash": { contextWindow: 123456, maxTokens: 4321, cost: { input: 9, output: 10, cacheRead: 2, cacheWrite: 3 } } },
    } } }));
    await writeFile(agyPath, '#!/bin/sh\ncase " $* " in *" --input-format "*) printf \'{"event":"init"}\\n\'; while :; do sleep 1; done;; esac\nprintf "gemini-3.8-flash-high  Gemini 3.8 Flash (High)\\ngemini-3.1-pro-high  Gemini 3.1 Pro (High)\\n"\n', { mode: 0o755 });
    const authPath = path.join(directory, "auth.json");
    await writeFile(authPath, JSON.stringify({ agy: { type: "api_key", env: { AGY_BRIDGE_ENABLED: "1" } } }));
    const runtime = await ModelRuntime.create({ modelsPath, authPath, refreshOnCreate: false });
    let sessionStart: ((event: unknown, ctx: unknown) => void | Promise<void>) | undefined;
    const pi = {
      on: (event: string, handler: typeof sessionStart) => { if (event === "session_start") sessionStart = handler; }, registerCommand: () => {},
      registerProvider: runtime.registerNativeProvider.bind(runtime),
    } as unknown as ExtensionAPI;
    t.mock.method(CliDriver.prototype, "detectExecutable", () => agyPath);
    t.mock.method(CliDriver.prototype, "discoverModels", async () => parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)\ngemini-3.1-pro-high  Gemini 3.1 Pro (High)"));
    await registerAndAwaitRefresh(t, runtime, () => new Bridge(pi, new CliDriver()).start());

    await runtime.refresh({ providers: ["agy"], allowNetwork: false });

    let resolveRefresh!: (result: Awaited<ReturnType<typeof runtime.refresh>>) => void;
    let rejectRefresh!: (error: unknown) => void;
    const backgroundRefreshFinished = new Promise<Awaited<ReturnType<typeof runtime.refresh>>>((resolve, reject) => {
      resolveRefresh = resolve;
      rejectRefresh = reject;
    });

    assert.ok(sessionStart);
    await sessionStart({}, {
      sessionManager: { getSessionId: () => "native-catalog-test" },
      modelRegistry: {
        refresh: (...args: Parameters<typeof runtime.refresh>) => {
          const refresh = runtime.refresh(...args);
          void refresh.then(resolveRefresh, rejectRefresh);
          return refresh;
        },
      },
    });
    const result = await backgroundRefreshFinished;

    assert.equal(result.aborted, false);
    assert.equal(result.errors.size, 0);
    assert.equal(runtime.getModel("agy", "gemini-3.8-flash")?.contextWindow, 123456);
    assert.equal(runtime.getModel("agy", "gemini-3.8-flash")?.maxTokens, 4321);
    assert.deepEqual(runtime.getModel("agy", "gemini-3.8-flash")?.cost, { input: 9, output: 10, cacheRead: 2, cacheWrite: 3, tiers: undefined });
    const stored = JSON.parse(await readFile(path.join(directory, "models-store.json"), "utf8"));
    assert.equal(stored.agy.models[0].contextWindow, 1048576);
    assert.equal(stored.agy.models[0].maxTokens, 65536);
    assert.deepEqual(stored.agy.models[0].cost, { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 });
    const proCost = {
      input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0,
      tiers: [{ inputTokensAbove: 200000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 0 }],
    };
    assert.deepEqual(stored.agy.models[1].cost, proCost);

    const next = await ModelRuntime.create({ modelsPath, authPath: path.join(directory, "auth.json"), refreshOnCreate: false });
    await registerAndAwaitRefresh(t, next, () => new Bridge(
      { ...pi, registerProvider: next.registerNativeProvider.bind(next) } as unknown as ExtensionAPI,
      new CliDriver(),
    ).start());
    const restored = await next.refresh({ providers: ["agy"], allowNetwork: false });
    assert.equal(restored.errors.size, 0);
    assert.equal(next.getModel("agy", "gemini-3.8-flash")?.contextWindow, 123456);
    assert.equal(next.getModel("agy", "gemini-3.8-flash")?.maxTokens, 4321);
    assert.deepEqual(next.getModel("agy", "gemini-3.1-pro")?.cost, proCost);
    assert.deepEqual(next.getModel("agy", "gemini-3.8-flash")?.cost, { input: 9, output: 10, cacheRead: 2, cacheWrite: 3, tiers: undefined });
  });

});
describe("model switching and conversation continuity", () => {
  type ModelSwitchCase = {
    name: string;
    arrange: {
      persisted: boolean;
      conversationId: string;
      foreignHistory: boolean;
      pending: boolean;
      selectedModel: "gemini" | "claude";
      outcome: "success" | "reject" | "dead" | "mismatch" | "abort" | "fallbackReject" | "sendReject";
      priorError?: string;
      omitPriorError?: boolean;
    };
    expected: {
      terminal: "error" | "aborted";
      starts: number;
      sends: number;
      store: "retained" | "deleted";
    } | {
      terminal: "done";
      starts: number;
      sends: number;
      model: "gemini" | "claude";
      runtimeConversation: string | undefined;
      responseId: string;
      preservesTerminal: boolean;
      continuation: { kind: "pending" } | { kind: "prompt"; reconstructed: boolean; fallback: boolean };
    };
  };

  const modelSwitchCases: ModelSwitchCase[] = [
    {
      name: "Gemini to Claude",
      arrange: {
        persisted: true, conversationId: "same-conversation", foreignHistory: false,
        pending: false, selectedModel: "claude", outcome: "success",
      },
      expected: {
        terminal: "done", starts: 1, sends: 1,
        model: "claude", runtimeConversation: "same-conversation",
        responseId: "same-conversation", preservesTerminal: true,
        continuation: { kind: "prompt", reconstructed: false, fallback: false },
      },
    },
    {
      name: "live reference only",
      arrange: {
        persisted: false, conversationId: "same-conversation", foreignHistory: false,
        pending: false, selectedModel: "claude", outcome: "success",
      },
      expected: {
        terminal: "done", starts: 1, sends: 1,
        model: "claude", runtimeConversation: "same-conversation",
        responseId: "same-conversation", preservesTerminal: true,
        continuation: { kind: "prompt", reconstructed: false, fallback: false },
      },
    },
    {
      name: "foreign roundtrip",
      arrange: {
        persisted: true, conversationId: "same-conversation", foreignHistory: false,
        pending: false, selectedModel: "gemini", outcome: "success",
      },
      expected: {
        terminal: "done", starts: 0, sends: 1,
        model: "gemini", runtimeConversation: undefined,
        responseId: "same-conversation", preservesTerminal: true,
        continuation: { kind: "prompt", reconstructed: false, fallback: false },
      },
    },
    {
      name: "foreign assistant without responseId",
      arrange: {
        persisted: true, conversationId: "same-conversation", foreignHistory: true,
        pending: false, selectedModel: "claude", outcome: "success",
      },
      expected: {
        terminal: "done", starts: 1, sends: 1,
        model: "claude", runtimeConversation: undefined,
        responseId: "fresh-conversation", preservesTerminal: false,
        continuation: { kind: "prompt", reconstructed: true, fallback: false },
      },
    },
    {
      name: "branch checkpoint",
      arrange: {
        persisted: true, conversationId: "branch-conversation", foreignHistory: false,
        pending: false, selectedModel: "claude", outcome: "success",
      },
      expected: {
        terminal: "done", starts: 1, sends: 1,
        model: "claude", runtimeConversation: "branch-conversation",
        responseId: "branch-conversation", preservesTerminal: false,
        continuation: { kind: "prompt", reconstructed: false, fallback: false },
      },
    },
    {
      name: "pending model switch",
      arrange: {
        persisted: true, conversationId: "same-conversation", foreignHistory: false,
        pending: true, selectedModel: "claude", outcome: "success",
      },
      expected: {
        terminal: "done", starts: 0, sends: 0,
        model: "gemini", runtimeConversation: undefined,
        responseId: "same-conversation", preservesTerminal: true,
        continuation: { kind: "pending" },
      },
    },
    {
      name: "resume rejects",
      arrange: {
        persisted: true, conversationId: "same-conversation", foreignHistory: false,
        pending: false, selectedModel: "claude", outcome: "reject",
      },
      expected: {
        terminal: "done", starts: 2, sends: 1,
        model: "claude", runtimeConversation: undefined,
        responseId: "fresh-conversation", preservesTerminal: false,
        continuation: { kind: "prompt", reconstructed: true, fallback: true },
      },
    },
    {
      name: "after-quota resume rejects and reconstructs failed history once",
      arrange: {
        persisted: true, conversationId: "same-conversation", foreignHistory: false,
        pending: false, selectedModel: "claude", outcome: "reject",
        priorError: "Individual quota reached. Resets in 3h27m34s.",
      },
      expected: {
        terminal: "done", starts: 2, sends: 1,
        model: "claude", runtimeConversation: undefined,
        responseId: "fresh-conversation", preservesTerminal: false,
        continuation: { kind: "prompt", reconstructed: true, fallback: true },
      },
    },
    {
      name: "Pi recovery projection removes the failed assistant",
      arrange: {
        persisted: true, conversationId: "same-conversation", foreignHistory: false,
        pending: false, selectedModel: "claude", outcome: "success",
        priorError: "Rate limit exceeded", omitPriorError: true,
      },
      expected: {
        terminal: "done", starts: 1, sends: 1,
        model: "claude", runtimeConversation: undefined,
        responseId: "fresh-conversation", preservesTerminal: false,
        continuation: { kind: "prompt", reconstructed: true, fallback: false },
      },
    },
    {
      name: "resume exits before input delivery",
      arrange: {
        persisted: true, conversationId: "same-conversation", foreignHistory: false,
        pending: false, selectedModel: "claude", outcome: "dead",
      },
      expected: {
        terminal: "done", starts: 2, sends: 1,
        model: "claude", runtimeConversation: undefined,
        responseId: "fresh-conversation", preservesTerminal: false,
        continuation: { kind: "prompt", reconstructed: true, fallback: true },
      },
    },
    {
      name: "resume mismatched init",
      arrange: {
        persisted: true, conversationId: "same-conversation", foreignHistory: false,
        pending: false, selectedModel: "claude", outcome: "mismatch",
      },
      expected: {
        terminal: "done", starts: 2, sends: 1,
        model: "claude", runtimeConversation: undefined,
        responseId: "fresh-conversation", preservesTerminal: false,
        continuation: { kind: "prompt", reconstructed: true, fallback: true },
      },
    },
    {
      name: "resume abort",
      arrange: {
        persisted: true, conversationId: "same-conversation", foreignHistory: false,
        pending: false, selectedModel: "claude", outcome: "abort",
      },
      expected: {
        terminal: "aborted", starts: 1, sends: 0,
        store: "retained",
      },
    },
    {
      name: "fallback fails",
      arrange: {
        persisted: true, conversationId: "same-conversation", foreignHistory: false,
        pending: false, selectedModel: "claude", outcome: "fallbackReject",
      },
      expected: {
        terminal: "error", starts: 2, sends: 0,
        store: "deleted",
      },
    },
    {
      name: "active send fails",
      arrange: {
        persisted: true, conversationId: "same-conversation", foreignHistory: false,
        pending: false, selectedModel: "claude", outcome: "sendReject",
      },
      expected: {
        terminal: "error", starts: 1, sends: 1,
        store: "deleted",
      },
    },
  ];

  for (const { name, arrange, expected } of modelSwitchCases) {
    test(`provider model switching: ${name}`, async (t) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "agy-model-switch-"));
      const originalGeminiHome = process.env.GEMINI_HOME;
      process.env.GEMINI_HOME = directory;
      t.after(() => {
        if (originalGeminiHome === undefined) delete process.env.GEMINI_HOME;
        else process.env.GEMINI_HOME = originalGeminiHome;
      });
      const pi = {
        on: () => {}, registerProvider: () => {}, registerCommand: () => {},
        getActiveTools: () => [], getAllTools: () => [],
      } as unknown as ExtensionAPI;
      const agyPath = path.join(directory, "agy");
      t.mock.method(CliDriver.prototype, "detectExecutable", () => agyPath);
      const bridge = new Bridge(pi, new CliDriver());

      t.after(async () => {
        try { await bridge.liveSessions.disposeAll(); }
        finally { await rm(directory, { recursive: true, force: true }); }
      });

      await writeFile(agyPath, '#!/bin/sh\necho 1.2.14\n', { mode: 0o755 });
      const manager = SessionManager.inMemory(directory);
      const sessionId = bridge.piContextAdapter.bind(manager);
      const session = bridge.liveSessions.getOrCreate(sessionId);
      const model = (id: string): Model<any> => ({
        id, name: id, api: "agy", provider: "agy", baseUrl: "agy", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
      } as Model<any>);
      const gemini = model("gemini");
      const selected = model(arrange.selectedModel);
      const assistant: AssistantMessage = {
        role: "assistant", content: [{ type: "text", text: "previous answer" }], api: "agy", provider: "agy",
        model: gemini.id, responseId: "same-conversation", stopReason: arrange.priorError ? "error" : "stop", timestamp: 2,
        ...(arrange.priorError ? { errorMessage: arrange.priorError } : {}),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const prefix: Context["messages"] = [{ role: "user", content: "original request", timestamp: 1 }, assistant];
      const compatibilityKey = createHash("sha256").update(prepareDriverCwd("cli")).digest("hex");
      const oldProc = new CliRuntimeSession({ agentName: "pi-bridge", model: gemini.id }, new Set(), {}, compatibilityKey);
      const oldMcp = new BridgeIPC([], session.id, session.resources);
      session.setSession(oldProc, calculateSyncKey("Rules", [], gemini.id, "", "pi-bridge"), oldMcp, "same-conversation");
      const terminalHandle = session.resources.terminals.bind("pi-terminal");
      bridge.runtimeSessionSync.record(session, prefix);
      assistant.responseId = arrange.conversationId;
      if (arrange.persisted) await bridge.runtimeSessionStore.set(sessionId, { sessionId: arrange.conversationId, compatibilityKey }, prefix, bridge.driver.sessionVersion);
      if (arrange.omitPriorError) prefix.splice(1, 1);
      if (arrange.foreignHistory) {
        const { responseId: _responseId, ...foreignAssistant } = assistant;
        prefix.push({ role: "user", content: "foreign question", timestamp: 3 }, {
          ...foreignAssistant, provider: "foreign", api: "foreign", model: "foreign",
          content: [{ type: "text", text: "foreign answer" }], timestamp: 4,
        });
      }
      let pending = arrange.pending;
      if (pending) {
        assistant.stopReason = "toolUse";
        assistant.content = [{ type: "toolCall", id: "pending-call", name: "test-tool", arguments: {} }];
        bridge.runtimeSessionSync.record(session, prefix);
        await bridge.runtimeSessionStore.set(sessionId, { sessionId: "same-conversation", compatibilityKey }, prefix, bridge.driver.sessionVersion);
      }
      const context: Context = { systemPrompt: "Rules", tools: [], messages: [...prefix, pending
        ? { role: "toolResult", toolCallId: "pending-call", toolName: "test-tool", content: [{ type: "text", text: "tool answer" }], isError: false, timestamp: 5 }
        : { role: "user", content: "new request", timestamp: 5 }] };
      const controller = new AbortController();
      const listeners = new Map<AgyRuntime, Parameters<AgyRuntime["onEvent"]>[0]>();
      const lifecycle: string[] = [];
      t.mock.getter(AgyRuntime.prototype, "isRunning", () => arrange.outcome !== "dead" || start.mock.callCount() !== 1);
      t.mock.getter(BridgeIPC.prototype, "hasPendingCalls", function (this: BridgeIPC) { return this === oldMcp && pending; });
      t.mock.getter(BridgeIPC.prototype, "bridgeUri", () => "unix:///synthetic.sock?session=test");
      t.mock.method(CliDriver.prototype, "installPlugin", async () => {});
      t.mock.method(BridgeIPC.prototype, "start", async () => {});
      t.mock.method(BridgeIPC.prototype, "close", async () => { lifecycle.push("close"); });
      t.mock.method(AgyRuntime.prototype, "abort", async () => { lifecycle.push("abort"); });
      const start = t.mock.method(AgyRuntime.prototype, "start", async function (this: AgyRuntime) {
        const attempt = start.mock.callCount() + 1;
        lifecycle.push(`start:${this.options.conversationId ?? "fresh"}`);
        if (attempt === 1 && ["reject", "abort", "fallbackReject"].includes(arrange.outcome)) {
          if (arrange.outcome === "abort") controller.abort(new Error("startup aborted"));
          throw new Error("resume rejected");
        }
        if (attempt === 2 && arrange.outcome === "fallbackReject") throw new Error("fresh rejected");
        return { event: "init", conversation_id: arrange.outcome === "mismatch" || !this.options.conversationId
          ? "fresh-conversation" : this.options.conversationId } as Awaited<ReturnType<AgyRuntime["start"]>>;
      });
      t.mock.method(AgyRuntime.prototype, "onEvent", function (this: AgyRuntime, listener: Parameters<AgyRuntime["onEvent"]>[0]) {
        listeners.set(this, listener);
        return () => { listeners.delete(this); };
      });
      const finish = (proc: AgyRuntime) => {
        const listener = listeners.get(proc);
        assert.ok(listener, "subscribe before delivering runtime results");
        listener({ event: "step_update", delta: "finished" }, "agy");
        listener({ event: "result", status: "success", conversation_id: proc === oldProc ? "same-conversation" : session.conversationId! }, "agy");
      };
      const send = t.mock.method(AgyRuntime.prototype, "send", async function (this: AgyRuntime, _input: AgyInput) {
        if (arrange.outcome === "sendReject") throw new Error("active turn failed");
        finish(this);
      });
      const resolve = t.mock.method(BridgeIPC.prototype, "resolveToolResults", (results: Context["messages"]) => {
        assert.equal(results.length, 1);
        pending = false;
        setImmediate(() => finish(oldProc));
        return 1;
      });
      const run = async (selectedModel: Model<any>) => {
        const events: AssistantMessageEvent[] = [];
        for await (const event of streamProvider(selectedModel, context, { sessionId, signal: controller.signal }, bridge)) events.push(event);
        await new Promise<void>((resolve) => setImmediate(resolve));
        return events.at(-1);
      };

      const terminal = await run(selected);

      assert.equal(start.mock.callCount(), expected.starts);
      assert.equal(send.mock.callCount(), expected.sends);
      if (expected.terminal !== "done") {
        assert.ok(terminal?.type === "error");
        assert.equal(terminal.reason, expected.terminal);
        assert.equal(session.activeProcess, null);
        assert.equal(session.activeMcpServer, null);
        assert.equal(resolve.mock.callCount(), 0);
        const stored = await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion);
        assert.equal(stored?.sessionId, expected.store === "retained" ? arrange.conversationId : undefined);
        assert.equal(listeners.size, 0);
        return;
      }

      assert.ok(terminal?.type === "done");
      assert.equal(terminal.message.model, expected.model);
      assert.equal(terminal.message.responseId, expected.responseId);
      assert.ok(session.activeProcess instanceof CliRuntimeSession);
      assert.equal(session.activeProcess?.options.model, expected.model);
      assert.equal(session.activeProcess?.options.conversationId, expected.runtimeConversation);
      assert.equal(session.resources.terminals.resolve(terminalHandle), expected.preservesTerminal ? "pi-terminal" : undefined);
      assert.equal((await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion))?.sessionId, expected.responseId);
      assert.equal(listeners.size, 0);
      assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), context.messages.length + 1);

      if (expected.continuation.kind === "pending") {
        assert.equal(resolve.mock.callCount(), 1);
        assert.equal(session.activeProcess, oldProc);

        context.messages.push(terminal.message, { role: "user", content: "next request", timestamp: 6 });
        const next = await run(selected);

        assert.ok(next?.type === "done");
        assert.equal(next.message.model, selected.id);
        assert.equal(next.message.responseId, "same-conversation");
        assert.equal(start.mock.callCount(), 1);
        assert.equal(send.mock.callCount(), 1);
        assert.equal(session.activeProcess?.options.model, selected.id);
        assert.equal(session.activeProcess?.options.conversationId, "same-conversation");
        assert.equal(session.resources.terminals.resolve(terminalHandle), "pi-terminal");
        assert.equal(send.mock.calls[0]!.arguments[0].message.content, "next request");
        assert.equal((await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion))?.sessionId, next.message.responseId);
        assert.equal(bridge.runtimeSessionSync.getSyncedMessageCount(session), context.messages.length + 1);
        assert.equal(listeners.size, 0);
        return;
      }

      const prompt = send.mock.calls[0]!.arguments[0].message.content;
      if (expected.continuation.reconstructed) {
        assert.ok(prompt.startsWith("[System]: Rules"));
        assert.ok(prompt.endsWith("new request"));
        assert.ok(prompt.indexOf("[User]: original request") < prompt.lastIndexOf("new request"));
        if (arrange.foreignHistory) assert.ok(prompt.includes("[Assistant]: foreign answer"));
        if (arrange.omitPriorError) assert.equal(prompt.includes(arrange.priorError!), false);
        else if (arrange.priorError) assert.ok(prompt.includes(arrange.priorError));
      } else assert.equal(prompt, "new request");
      if (expected.continuation.fallback) assert.deepEqual(lifecycle.slice(0, 6), ["close", "abort", "start:same-conversation", "close", "abort", "start:fresh"]);
    });
  }
});
