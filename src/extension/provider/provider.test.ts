import { fileURLToPath } from "node:url";
import { registerAuthHomeFixture, useAuthHomeFixture } from "./auth-home-fixture.ts";
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { SessionManager, ModelRuntime, ModelRegistry, compact, generateSummaryWithUsage, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { Provider, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { AgyRuntime } from "../runtime/process.ts";
import { BridgeIPC } from "../bridge/ipc.ts";
import { Driver as CliDriver } from "../drivers/cli/driver.ts";
import { Driver as CliAcpDriver } from "../drivers/cli-acp/driver.ts";
import { createBridgeDriver } from "../drivers/driver.ts";
import { Driver as AcpDriver } from "../drivers/acp/driver.ts";
import { AgyAuthentication, createAgyBridgeCredential, getAgyBridgeAuthEnvironment } from "./auth.ts";
import { SessionMode } from "../drivers/types.ts";
import type { BridgeDriver, DriverId, DriverSession, RuntimeEvent } from "../drivers/types.ts";
import { parseModelsOutput } from "../discovery/models.ts";
import { Bridge, streamProvider } from "./provider.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

useAuthHomeFixture();

const allNullThinkingLevels = {
  off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null,
};

describe("streamProvider selection validation", () => {
  const fixedEffortCases = [
    {
      name: "rejects fixed claude-sonnet-4-6 reasoningEffort=low before runtime preparation",
      modelId: "claude-sonnet-4-6", options: { reasoningEffort: "low" },
      error: "Unsupported Antigravity CLI reasoning effort for claude-sonnet-4-6: low.",
    },
    {
      name: "rejects fixed claude-opus-4-6-thinking reasoning=medium before runtime preparation",
      modelId: "claude-opus-4-6-thinking", options: { reasoning: "medium" },
      error: "Unsupported Antigravity CLI reasoning effort for claude-opus-4-6-thinking: medium.",
    },
    {
      name: "rejects fixed claude-sonnet-4-6 thinkingLevel=high before runtime preparation",
      modelId: "claude-sonnet-4-6", options: { thinkingLevel: "high" },
      error: "Unsupported Antigravity CLI reasoning effort for claude-sonnet-4-6: high.",
    },
  ] as const;

  for (const row of fixedEffortCases) {
    test(row.name, async (t) => {
      const bridge = new Bridge({} as ExtensionAPI, new CliDriver());
      const runtimeLookup = t.mock.method(bridge.runtimeSessionStore, "get", async () => {
        throw new Error("Runtime preparation must not begin");
      });
      const model = { id: row.modelId, provider: "agy", thinkingLevelMap: allNullThinkingLevels } as Model<any>;

      const message = await streamProvider(model, { messages: [], tools: [] }, {
        sessionId: "validation-test", ...row.options,
      }, bridge).result();

      assert.equal(message.stopReason, "error");
      assert.equal(message.errorMessage, row.error);
      assert.equal(runtimeLookup.mock.callCount(), 0);
      assert.equal(bridge.liveSessions.get("validation-test"), undefined);
    });
  }
});

describe("Bridge.start registration", () => {
  test("registers the Antigravity CLI provider and session lifecycle without starting runtime work", async (t) => {
    const spawn = t.mock.method(cp, "spawn", () => { throw new Error("Registration must not start a process"); });
    const execFile = t.mock.method(cp, "execFile", () => { throw new Error("Registration must not execute a command"); });
    const runtimeStart = t.mock.method(AgyRuntime.prototype, "start", async () => { throw new Error("Registration must not start the runtime"); });
    syncBuiltinESMExports();
    const handlers = new Map<string, unknown>();
    const commands = new Map<string, unknown>();
    let provider: Provider | undefined;
    t.after(async () => {
      try {
        await (handlers.get("session_shutdown") as (() => Promise<void>) | undefined)?.();
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });

    const pi = {
      on: (event: string, handler: unknown) => handlers.set(event, handler),
      registerCommand: (name: string, options: unknown) => commands.set(name, options),
      registerProvider: (registered: Provider) => {
        provider = registered;
      },
    } as unknown as ExtensionAPI;

    new Bridge(pi, new CliDriver()).start();

    assert.ok(commands.has("agy-bridge:doctor"));
    assert.ok(provider);
    assert.equal(provider.id, "agy");
    assert.equal(provider.name, "Antigravity [pi-agy-bridge]");
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
  });
});

describe("driver command", () => {
  for (const row of [
    { name: "explicit CLI", current: "acp", args: "cli", selected: undefined, target: "cli" },
    { name: "explicit ACP", current: "cli", args: "acp", selected: undefined, target: "acp" },
    { name: "explicit CLI ACP normalizes input", current: "acp", args: " CLI-ACP ", selected: undefined, target: "cli-acp" },
    { name: "UI CLI", current: "acp", args: "", selected: "CLI", target: "cli" },
    { name: "UI ACP", current: "cli", args: "", selected: "ACP", target: "acp" },
    { name: "UI CLI ACP", current: "acp", args: "", selected: "CLI-ACP", target: "cli-acp" },
    { name: "UI cancellation", current: "acp", args: "", selected: undefined, target: undefined },
    { name: "UI current CLI ACP", current: "cli-acp", args: "", selected: "CLI-ACP (current)", target: undefined },
    { name: "explicit current CLI ACP", current: "cli-acp", args: "cli-acp", selected: undefined, target: undefined },
    { name: "unknown driver", current: "acp", args: "unknown", selected: undefined, target: undefined },
  ] as const) {
    test(row.name, async (t) => {
      const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
      let shutdown: (() => Promise<void>) | undefined;
      const bridge = new Bridge({
        on: (event: string, handler: () => Promise<void>) => { if (event === "session_shutdown") shutdown = handler; },
        registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => commands.set(name, command),
        registerProvider: () => {},
      } as unknown as ExtensionAPI, createBridgeDriver(row.current));
      t.after(async () => { await shutdown?.(); });
      // Keep command selection isolated from the follow-up diagnostics.
      const switchDriver = t.mock.method(bridge, "switchDriver", async () => ({ signal: AbortSignal.abort() }));
      const select = t.mock.fn(async () => row.selected);
      const notify = t.mock.fn();
      const setStatus = t.mock.fn();
      const ctx = { hasUI: true, ui: { select, notify, setStatus } } as unknown as ExtensionCommandContext;
      bridge.start();
      const command = commands.get("agy-bridge:driver")!;

      await command.handler(row.args, ctx);

      assert.ok(command.description);
      assert.match(command.description, /\[cli\|acp\|cli-acp\]/);
      if (!row.args) {
        assert.deepEqual(select.mock.calls[0]?.arguments, ["Select Antigravity driver",
          ["acp", "cli", "cli-acp"].map((id) => `${id.toUpperCase()}${id === row.current ? " (current)" : ""}`)]);
      } else assert.equal(select.mock.callCount(), 0);
      assert.equal(switchDriver.mock.callCount(), row.target ? 1 : 0);
      if (row.target) {
        assert.deepEqual(switchDriver.mock.calls[0]?.arguments, [row.target, undefined]);
        assert.deepEqual(setStatus.mock.calls.map((call) => call.arguments), [
          ["agy-bridge", `Switching to ${createBridgeDriver(row.target).label}…`], ["agy-bridge", undefined],
        ]);
        assert.equal(notify.mock.callCount(), 0);
      } else if (row.args === "unknown") {
        assert.deepEqual(notify.mock.calls[0]?.arguments, ['Unknown driver "unknown". Available: cli, acp, cli-acp.', "warning"]);
      } else if (row.current === "cli-acp") {
        assert.deepEqual(notify.mock.calls[0]?.arguments, ["Already using driver: **Antigravity CLI ACP** (cli-acp).", "info"]);
      } else assert.equal(notify.mock.callCount(), 0);
    });
  }

  for (const executable of [undefined, "/mock/agy"] as const) {
    test(`non-UI status includes CLI ACP ${executable ? "installed" : "missing"}`, async (t) => {
      const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
      let shutdown: (() => Promise<void>) | undefined;
      t.mock.method(AcpDriver.prototype, "detectExecutable", () => "/mock/acp");
      t.mock.method(CliDriver.prototype, "detectExecutable", () => "/mock/cli");
      const detect = t.mock.method(CliAcpDriver.prototype, "detectExecutable", () => executable);
      const output = t.mock.method(console, "error", () => {});
      const bridge = new Bridge({
        on: (event: string, handler: () => Promise<void>) => { if (event === "session_shutdown") shutdown = handler; },
        registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => commands.set(name, command),
        registerProvider: () => {},
      } as unknown as ExtensionAPI);
      t.after(async () => { await shutdown?.(); });
      bridge.start();

      await commands.get("agy-bridge:driver")!.handler("", { hasUI: false } as ExtensionCommandContext);

      assert.equal(bridge.driver.id, "acp");
      assert.equal(detect.mock.callCount(), 1);
      const status = output.mock.calls[0]?.arguments[0];
      assert.equal(typeof status, "string");
      assert.ok(status.includes(`- **cli-acp**: ${executable ? `✓ Found (${executable})` : "✗ Not found"}`));
      assert.match(status, /Default: ACP\./);
      assert.match(status, /`\/agy-bridge:driver cli-acp`/);
    });
  }
});

describe("startup subscription", () => {
  for (const row of [
    { name: "automatically enables an existing Antigravity CLI login", stored: "missing", authenticated: true, enabled: true },
    { name: "leaves an unauthenticated Antigravity CLI unconfigured", stored: "missing", authenticated: false, enabled: false },
    { name: "detects existing OAuth login", stored: "oauth", authenticated: true, enabled: true },
    { name: "detects expired OAuth login", stored: "expired", authenticated: true, enabled: true },
    { name: "synchronizes the legacy setup marker", stored: "legacy", authenticated: true, enabled: true },
  ] as const) {
    test(`startup subscription: ${row.name}`, async (t) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "agy-auto-subscription-"));
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = directory;
      t.after(() => {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      });
      const authPath = path.join(directory, "auth.json");
      const marker = createAgyBridgeCredential();
      if (row.stored !== "missing") {
        await writeFile(authPath, JSON.stringify({ agy: row.stored === "legacy" ? {
          type: "api_key", env: { AGY_BRIDGE_ENABLED: "1", AGY_BRIDGE_LOGIN_EPOCH: "existing-epoch" },
        } : { ...marker, expires: row.stored === "expired" ? 0 : marker.expires } }));
      }
      const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
      const registry = new ModelRegistry(runtime);
      const probe = t.mock.fn(async () => row.authenticated);
      const detect = t.mock.method(AgyAuthentication.prototype, "detect", async function (this: AgyAuthentication) {
        const authenticated = await probe();
        this.status = authenticated ? "authenticated" : "unauthenticated";
        return authenticated ? marker : undefined;
      });
      const spawn = t.mock.method(cp, "spawn", () => { throw new Error("Unexpected authentication subprocess"); });
      syncBuiltinESMExports();
      let sessionStart: ((event: SessionStartEvent, ctx: ExtensionContext) => void | Promise<void>) | undefined;
      let shutdown: (() => Promise<void>) | undefined;
      let refreshed!: () => void;
      let refreshFailed!: (reason: unknown) => void;
      const refreshFinished = new Promise<void>((resolve, reject) => { refreshed = resolve; refreshFailed = reject; });
      const refreshOperations: Promise<unknown>[] = [];
      const ctx = {
        sessionManager: { getSessionId: () => "auto-subscription-test" },
        modelRegistry: {
          refresh: async (options: Parameters<ModelRegistry["refresh"]>[0]) => {
            try {
              const operation = registry.refresh(options);
              refreshOperations.push(operation);
              const result = await operation;
              refreshed();
              return result;
            } catch (error) {
              refreshFailed(error);
              throw error;
            }
          },
        },
      } as unknown as ExtensionContext;
      t.after(async () => {
        await shutdown?.();
        await Promise.allSettled(refreshOperations);
        spawn.mock.restore();
        detect.mock.restore();
        syncBuiltinESMExports();
        await rm(directory, { recursive: true, force: true });
      });
      const pi = {
        on: (event: string, handler: unknown) => {
          if (event === "session_start") sessionStart = handler as typeof sessionStart;
          if (event === "session_shutdown") shutdown = handler as typeof shutdown;
        },
        registerCommand: () => {}, getActiveTools: () => [], getAllTools: () => [],
        registerProvider: runtime.registerNativeProvider.bind(runtime),
      } as unknown as ExtensionAPI;
      t.mock.method(CliDriver.prototype, "discoverModels", async () =>
        parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)"));
      new Bridge(pi, new CliDriver()).start();
      assert.ok(sessionStart);
      assert.equal(sessionStart({ type: "session_start", reason: "startup" }, ctx), undefined);
      await refreshFinished;

      assert.equal(detect.mock.callCount(), 1);
      assert.equal(probe.mock.callCount(), 1);
      const enabled = row.enabled;
      assert.equal(runtime.isUsingSubscription("agy"), enabled);
      assert.equal(registry.getAvailable().length, enabled ? 1 : 0);
      assert.deepEqual(await runtime.listCredentials(), enabled ? [{ providerId: "agy", type: "oauth" }] : []);
      if (row.enabled) {
        const auth = await runtime.getAuth("agy");
        const saved = JSON.parse(await readFile(authPath, "utf8")).agy;
        assert.equal(saved.type, "oauth");
        assert.equal(saved.access, "");
        assert.equal(saved.refresh, "");
        assert.equal(saved.loginEpoch, undefined);
        assert.ok(saved.expires > Date.now() + 300000);
        assert.deepEqual(getAgyBridgeAuthEnvironment(auth?.auth.apiKey), { AGY_BRIDGE_ENABLED: "1" });
      }
      assert.equal(spawn.mock.callCount(), 0);

      await runtime.logout("agy");
      for (const reason of ["new", "reload", "startup"] as const) {
        sessionStart({ type: "session_start", reason }, ctx);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.deepEqual(await runtime.listCredentials(), []);
      assert.equal(detect.mock.callCount(), 1,
        "logout must not trigger automatic re-enablement in the current bridge instance");

      if (row.authenticated) {
        await Promise.allSettled(refreshOperations);
        await shutdown?.();
        const restartedRefresh = new Promise<void>((resolve, reject) => { refreshed = resolve; refreshFailed = reject; });
        new Bridge(pi, new CliDriver()).start();
        sessionStart({ type: "session_start", reason: "startup" }, ctx);
        await restartedRefresh;
        assert.equal(detect.mock.callCount(), 2);
        assert.equal(probe.mock.callCount(), 2);
        assert.equal(runtime.isUsingSubscription("agy"), true);
        assert.equal(registry.getAvailable().length, 1);
      }
    });
  }
});

describe("background checks", () => {
  for (const id of ["cli", "acp"] as const) {
    for (const authenticated of [false, true]) {
      test(`${id} background checks report authenticated=${authenticated} and clean up before returning`, async (t) => {
        const home = await registerAuthHomeFixture(t);
        const previous = { home: process.env.GEMINI_HOME, dir: process.env.AGY_ACP_DIR };
        process.env.GEMINI_HOME = home;
        delete process.env.AGY_ACP_DIR;
        t.after(() => {
          if (previous.home === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = previous.home;
          if (previous.dir === undefined) delete process.env.AGY_ACP_DIR; else process.env.AGY_ACP_DIR = previous.dir;
        });
        const authPath = path.join(home, "auth.json");
        await writeFile(authPath, JSON.stringify(authenticated ? { agy: { ...createAgyBridgeCredential(), driver: id } } : {}));
        let fixtureAuthenticated = authenticated;
        const executable = path.join(home, "agy");
        const writeCli = () => writeFile(executable, '#!/bin/sh\ncase "$1" in\n--version) echo 1.2.14;;\nmodels) printf "cached-model-high  Cached Model (High)\\n";;\n*) ' + (fixtureAuthenticated
          ? 'printf "Claude  Five hour  50%%\\n"'
          : 'printf "Authentication required. Please visit the URL to log in:\\n" >&2; while :; do sleep 1; done') + ';;\nesac\n', { mode: 0o700 });
        await writeCli();
        const driver = id === "cli" ? new CliDriver() : new AcpDriver(async () => ({
          executable: process.execPath,
          args: ["--experimental-strip-types", fileURLToPath(new URL("../drivers/acp/discovery-fixture.ts", import.meta.url)), fixtureAuthenticated ? "catalog" : "browser"],
        }));
        t.mock.method(driver, "detectExecutable", () => id === "cli" ? executable : undefined);
        const handlers = new Map<string, (...args: any[]) => any>();
        const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
        const messages: string[] = [];
        t.mock.method(console, "error", (message: string) => { messages.push(message); });
        const sendMessage = t.mock.fn();
        let provider!: Provider;
        const bridge = new Bridge({
          on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
          registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, command.handler),
          registerProvider: (registered: Provider) => { provider = registered; },
          sendMessage,
        } as unknown as ExtensionAPI, driver);
        const listeners = process.listenerCount("exit");
        bridge.start();
        t.after(async () => { await handlers.get("session_shutdown")!(); });
        const cached = parseModelsOutput("cached-model-high  Cached Model (High)");
        let refreshed!: () => void;
        const refresh = async () => {
          await provider.refreshModels!({
            stored: { models: cached }, allowNetwork: true, signal: new AbortController().signal,
            publish: async (publication) => {
              if (id === "acp" && !fixtureAuthenticated) assert.equal(publication.persist, undefined, "login must not replace the model cache");
              publication.update?.();
              return true;
            },
          });
          refreshed?.();
        };
        const ctx = { hasUI: false, sessionManager: SessionManager.inMemory(), modelRegistry: { refresh } } as unknown as ExtensionCommandContext;

        for (const reason of ["startup", "switch"]) {
          const finished = new Promise<void>((resolve) => { refreshed = resolve; });
          handlers.get("session_start")!({ reason }, ctx);
          await finished;
        }
        const startupMessages = sendMessage.mock.callCount();
        await commands.get("agy-bridge:doctor")!("", ctx);

        assert.equal(messages.length, 1);
        assert.equal(sendMessage.mock.callCount(), startupMessages, "doctor must not send conversation messages");
        assert.match(messages.at(-1)!, authenticated ? /✓ Auth: authenticated/ : /x Auth: unauthenticated/);
        assert.doesNotMatch(messages.at(-1)!, /\nErrors\n/);
        assert.equal(process.listenerCount("exit"), listeners);
        if (authenticated) {
          const stored = JSON.parse(await readFile(authPath, "utf8"));
          assert.equal(stored.agy.loginEpoch, undefined);
        } else {
          assert.equal(JSON.parse(await readFile(authPath, "utf8")).agy, undefined);
          assert.match(messages.at(-1)!, /Run \/login/);
          assert.deepEqual(provider.getModels(), cached);
        }

        fixtureAuthenticated = true;
        await writeCli();
        await provider.auth.oauth!.login({
          signal: new AbortController().signal, notify: () => {},
          prompt: async () => { throw new Error("Cached fixture login must not prompt"); },
        });
        await commands.get("agy-bridge:doctor")!("", ctx);

        assert.equal(messages.length, 2);
        assert.equal(sendMessage.mock.callCount(), startupMessages, "doctor must not send conversation messages after login");
        assert.match(messages.at(-1)!, /✓ Auth: authenticated/);
        assert.doesNotMatch(messages.at(-1)!, /\nErrors\n/);
        assert.equal(process.listenerCount("exit"), listeners);
      });
    }
  }
});

describe("standalone compaction", () => {
  const compactionSummaryModel = {
    id: "summary-model", name: "summary-model", provider: "agy", api: "agy", baseUrl: "agy",
    maxTokens: 1024, contextWindow: 8192, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as Model<any>;

  for (const id of ["cli", "acp"] as DriverId[]) {
    for (const outcome of ["success", "error", "blocked-tool", "abort", "delayed-abort", "preparation-error"] as const) {
      test(`${id} standalone native summary: ${outcome}`, async (t) => {
        const controller = new AbortController();
        let disposed = 0;
        let prepared = 0;
        let handler: ((event: RuntimeEvent) => void) | undefined;
        let proc: DriverSession | undefined;
        let submitReturned: (() => void) | undefined;
        const submitted = new Promise<void>((resolve) => { submitReturned = resolve; });
        const driver: BridgeDriver = {
          id, label: id, sessionVersion: "test:v1", initialModels: [],
          authentication: { label: id, probe: async () => false, login: async () => {} },
          validateSelection() {}, detectExecutable: () => undefined,
          discoverModels: async () => [], usage: async () => undefined,
          async prepareSession(input) {
            prepared++;
            assert.equal(input.mode, SessionMode.Standalone);
            assert.deepEqual(input.tools, []);
            assert.equal(await input.store.get(input.session.piSessionId, "test:v1"), undefined);
            await input.store.delete(input.session.piSessionId);
            assert.equal(input.options?.cacheRetention, "none");
            assert.equal(input.context.messages[0]?.role, "system");
            assert.match(JSON.stringify(input.context.messages), /Original conversation detail/);
            assert.deepEqual(input.context.messages, normalizeContext(input.context).messages);
            if (outcome === "preparation-error") throw new Error("preparation rejected");

            const ipc = new BridgeIPC([], input.session.id, input.session.resources);
            let running = true;
            proc = {
              driver: id, get isRunning() { return running; },
              onRuntimeEvent(callback) { handler = callback; return () => { handler = undefined; }; },
              serializeContextUpdate: () => "",
              abort: async () => { disposed++; running = false; },
              async submit(submission) {
                assert.equal(submission.messages.length > 0, true);
                assert.equal(submission.beforeInput(), true);
                if (outcome === "abort") { controller.abort(); return; }
                if (outcome === "delayed-abort") { submitReturned?.(); return; }
                if (outcome === "blocked-tool") {
                  handler?.({ type: "blocked-native-tool", name: "read" });
                  return;
                }
                handler?.({ type: "text-delta", delta: "Concise summary" });
                handler?.({ type: "complete", reason: outcome === "error" ? "error" : "stop", error: outcome === "error" ? "backend rejected" : undefined, resumable: false });
              },
            };
            input.session.setSession(proc, "summary", ipc, "summary-conversation", input.preparationId);
            return { proc, mcpServer: ipc, reconstructContext: true, modelId: compactionSummaryModel.id };
          },
        };
        const bridge = new Bridge({ getActiveTools: () => ["read"], getAllTools: () => [{ name: "read" }] } as unknown as ExtensionAPI, driver);
        t.after(async () => {
          controller.abort();
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (proc?.isRunning) await proc.abort();
        });
        const manager = SessionManager.inMemory();
        const normalId = bridge.piContextAdapter.bind(manager);
        await bridge.runtimeSessionStore.set(normalId, { sessionId: "normal-conversation" }, [], "test:v1");
        const normalBranch = manager.getBranch();
        const persist = t.mock.method(bridge.runtimeSessionStore, "set", async () => { assert.fail("standalone request must not persist a checkpoint"); });
        const lookup = t.mock.method(bridge.runtimeSessionStore, "get", async () => { assert.fail("standalone preparation must not read a checkpoint"); });
        const invalidate = t.mock.method(bridge.runtimeSessionStore, "delete", async () => { assert.fail("standalone request must not invalidate a checkpoint"); });
        t.mock.method(bridge.liveSessions, "getOrCreate", () => { assert.fail("standalone request must not enter live registry"); });

        let streamResult: ReturnType<ReturnType<typeof streamProvider>["result"]> | undefined;
        const summarize = () => generateSummaryWithUsage([{ role: "user", content: "Original conversation detail", timestamp: 1 }], compactionSummaryModel, 2048, undefined, undefined, controller.signal, undefined, undefined, undefined,
          (selected, context, options) => {
            const stream = streamProvider(selected, context, options, bridge);
            streamResult = stream.result();
            return stream;
          });

        if (outcome === "success") assert.equal((await summarize()).text, "Concise summary");
        else if (outcome === "abort") { await summarize(); assert.equal(controller.signal.aborted, true); }
        else if (outcome === "delayed-abort") {
          const summary = summarize();
          await submitted;
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal(proc?.isRunning, true);
          assert.equal(disposed, 0);
          assert.ok(handler);
          controller.abort();
          await summary;
          const result = await streamResult;
          assert.equal(result?.stopReason, "aborted");
          assert.equal(controller.signal.aborted, true);
        }
        else if (outcome === "blocked-tool") await assert.rejects(summarize, /unavailable tool: read/);
        else await assert.rejects(summarize, outcome === "error" ? /backend rejected/ : /preparation rejected/);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(persist.mock.callCount(), 0);
        assert.equal(invalidate.mock.callCount(), 0);
        assert.equal(lookup.mock.callCount(), 0);
        assert.deepEqual(manager.getBranch(), normalBranch);
        assert.equal(prepared, 1);
        assert.equal(disposed, outcome === "preparation-error" ? 0 : 1);
        if (outcome === "delayed-abort") {
          assert.equal(proc?.isRunning, false);
          assert.equal(handler, undefined);
          assert.equal(disposed, 1);
        }
      });
    }
  }

  test("ModelRuntime pre-resolved compaction auth succeeds for enabled credentials", async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-compaction-auth-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const authPath = path.join(directory, "auth.json");
    await writeFile(authPath, JSON.stringify({
      agy: { type: "api_key", env: { AGY_BRIDGE_ENABLED: "1" } },
    }));
    const runtime = await ModelRuntime.create({ modelsPath: null, authPath, refreshOnCreate: false });
    let handler: ((event: RuntimeEvent) => void) | undefined;
    const driver: BridgeDriver = {
      id: "acp", label: "acp", sessionVersion: "test:v1",
      initialModels: [compactionSummaryModel],
      authentication: { label: "acp", probe: async () => true, login: async () => {} },
      validateSelection() {}, detectExecutable: () => "/bin/sh",
      discoverModels: async () => [compactionSummaryModel],
      usage: async () => undefined,
      async prepareSession(input) {
        const ipc = new BridgeIPC([], input.session.id, input.session.resources);
        const proc: DriverSession = {
          driver: "acp", isRunning: true,
          onRuntimeEvent(callback) { handler = callback; return () => { handler = undefined; }; },
          serializeContextUpdate: () => "",
          abort: async () => {},
          async submit(submission) {
            assert.equal(submission.beforeInput(), true);
            handler?.({ type: "text-delta", delta: "Compacted through ModelRuntime" });
            handler?.({ type: "complete", reason: "stop", resumable: false });
          },
        };
        input.session.setSession(proc, "summary", ipc, "summary-conversation", input.preparationId);
        return { proc, mcpServer: ipc, reconstructContext: true, modelId: compactionSummaryModel.id };
      },
    };
    new Bridge({
      on: () => {}, registerCommand: () => {},
      getActiveTools: () => [], getAllTools: () => [],
      registerProvider: (registered: Provider) => runtime.registerNativeProvider(registered),
    } as unknown as ExtensionAPI, driver).start();
    await runtime.refresh({ providers: ["agy"], allowNetwork: false });
    const resolvedAuth = await runtime.getAuth(compactionSummaryModel);
    assert.ok(resolvedAuth);

    const result = await compact({
      firstKeptEntryId: "kept",
      messagesToSummarize: [{ role: "user", content: "Summarize me", timestamp: 1 }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 50,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
    }, compactionSummaryModel, resolvedAuth.auth.apiKey, undefined, undefined, undefined, undefined,
      (selected, context, options) => runtime.streamSimple(selected, context, options), resolvedAuth.env);

    assert.match(result.summary, /Compacted through ModelRuntime/);
  });

  for (const action of ["shutdown", "switch", "login"] as const) {
    test(`standalone compaction is cancelled on bridge ${action}`, async (t) => {
      const directory = await registerAuthHomeFixture(t);
      const runtime = await ModelRuntime.create({ modelsPath: null, authPath: path.join(directory, "auth.json"), refreshOnCreate: false });
      let shutdown!: () => Promise<void>;
      let submitted!: () => void;
      const waiting = new Promise<void>((resolve) => { submitted = resolve; });
      let handler: ((event: RuntimeEvent) => void) | undefined;
      let running = true;
      let aborts = 0;
      let ipc: BridgeIPC | undefined;
      const driver: BridgeDriver = {
        id: "acp", label: "acp", sessionVersion: "test:v1", initialModels: [compactionSummaryModel],
        authentication: { label: "acp", probe: async () => true, login: async () => {} },
        validateSelection() {}, detectExecutable: () => undefined,
        discoverModels: async () => [compactionSummaryModel], usage: async () => undefined,
        async prepareSession(input) {
          assert.deepEqual(input.tools, []);
          ipc = new BridgeIPC([], input.session.id, input.session.resources);
          const proc: DriverSession = {
            driver: "acp", get isRunning() { return running; },
            onRuntimeEvent(callback) { handler = callback; return () => { handler = undefined; }; },
            serializeContextUpdate: () => "",
            abort: async () => { aborts++; running = false; },
            async submit(submission) {
              assert.equal(submission.beforeInput(), true);
              submitted();
            },
          };
          input.session.setSession(proc, "summary", ipc, "summary-conversation", input.preparationId);
          return { proc, mcpServer: ipc, reconstructContext: true, modelId: compactionSummaryModel.id };
        },
      };
      const bridge = new Bridge({
        on: (name: string, callback: () => Promise<void>) => { if (name === "session_shutdown") shutdown = callback; },
        registerCommand: () => {},
        registerProvider: (provider: Provider) => runtime.registerNativeProvider(provider),
        getActiveTools: () => [], getAllTools: () => [],
      } as unknown as ExtensionAPI, driver);
      const controller = new AbortController();
      t.after(async () => { controller.abort(); await shutdown(); });
      bridge.start();
      await runtime.refresh({ providers: ["agy"], allowNetwork: false });
      const stream = runtime.streamSimple(compactionSummaryModel, {
        messages: [{ role: "user", content: "Summarize this conversation", timestamp: 1 }],
      }, {
        sessionId: "standalone-summary", cacheRetention: "none",
        apiKey: "agy-bridge:test-epoch", signal: controller.signal,
      });
      const result = stream.result();
      await waiting;
      assert.equal(running, true);
      assert.ok(handler);
      assert.equal(bridge.liveSessions.get("standalone-summary"), undefined);
      const close = t.mock.method(ipc!, "close");

      if (action === "shutdown") await shutdown();
      else if (action === "switch") {
        t.mock.method(CliDriver.prototype, "detectExecutable", () => "/mock/cli");
        t.mock.method(CliDriver.prototype, "discoverModels", async () => [compactionSummaryModel]);
        await bridge.switchDriver("cli");
      } else {
        await runtime.login("agy", "oauth", {
          signal: new AbortController().signal,
          notify: () => {}, prompt: async () => { throw new Error("Unexpected login prompt"); },
        });
      }

      assert.equal((await result).stopReason, "aborted");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(controller.signal.aborted, false, "bridge cancellation must not require caller cancellation");
      assert.equal(running, false);
      assert.equal(aborts, 1);
      assert.equal(close.mock.callCount(), 1);
      assert.equal(handler, undefined);
    });
  }
});
