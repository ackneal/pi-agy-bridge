import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { BridgeIPC } from "../../src/extension/bridge/ipc.ts";
import { Driver as AcpDriver } from "../../src/extension/drivers/acp/driver.ts";
import type { DriverSession } from "../../src/extension/drivers/types.ts";
import { Bridge } from "../../src/extension/provider/provider.ts";
import { createAgyBridgeCredential } from "../../src/extension/provider/auth.ts";
import type { LiveSession } from "../../src/extension/session/session.ts";

export async function createLivePiSession(options: {
  cwd: string;
  directory: string;
  model: Model<any>;
  launch: { executable: string; args: string[] };
  tool: ToolDefinition;
  signal: AbortSignal;
  evidence: unknown[];
}): Promise<{ session: AgentSession; bridge: Bridge; close: () => Promise<void> }> {
  options.signal.throwIfAborted();
  const temporaryRoot = await realpath(tmpdir());
  // The production ACP driver derives its working directory from GEMINI_HOME.
  // Require the harness's isolated home rather than changing process-global state.
  for (const directory of [options.cwd, options.directory, process.env.GEMINI_HOME]) {
    assert.ok(directory, "Live Pi requires an isolated GEMINI_HOME");
    const resolved = await realpath(directory);
    assert.ok(resolved.startsWith(temporaryRoot + path.sep), "Live Pi directories must be scratch directories");
  }
  assert.ok(!process.env.AGY_ACP_DIR?.trim(), "Unset AGY_ACP_DIR so the supplied launch is used");

  const scratch = await mkdtemp(path.join(options.directory, "pi-session-"));
  const agentDir = path.join(scratch, "agent");
  const cancellation = new AbortController();
  const signal = AbortSignal.any([options.signal, cancellation.signal]);
  const liveSessions = new Set<LiveSession>();
  const runtimes = new Set<DriverSession>();
  const brokers = new Set<BridgeIPC>();
  const preparations = new Set<Promise<unknown>>();
  let session: AgentSession | undefined;
  let bridge: Bridge | undefined;
  let closing: Promise<void> | undefined;
  let initialized = false;

  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      options.signal.removeEventListener("abort", onAbort);
      cancellation.abort(new Error("Live Pi fixture closed"));
      session?.abortCompaction();
      session?.abortBranchSummary();
      await Promise.allSettled([
        session?.abort(),
        ...preparations,
      ]);
      // Preparations can create standalone summary sessions outside the registry.
      for (const live of liveSessions) {
        if (live.activeProcess) runtimes.add(live.activeProcess);
        if (live.activeMcpServer) brokers.add(live.activeMcpServer);
      }
      const aborted = await Promise.allSettled([...runtimes].map(async runtime => {
        await runtime.abort();
        assert.equal(runtime.isRunning, false, "ACP runtime survived fixture cleanup");
      }));
      const closedBrokers = await Promise.allSettled([...brokers].map(async broker => {
        await broker.close();
        assert.equal(broker.hasPendingCalls, false, "Pi broker retained pending calls after cleanup");
      }));
      await Promise.allSettled([...liveSessions].map(live => live.dispose()));
      await bridge?.liveSessions.disposeAll();
      try {
        if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        session?.dispose();
        await rm(scratch, { recursive: true, force: true });
      }
      options.evidence.push({ piFixtureClosed: [...aborted, ...closedBrokers].every(result => result.status === "fulfilled"), runtimes: runtimes.size, brokers: brokers.size,
        running: [...runtimes].filter(runtime => runtime.isRunning).length,
        errors: [...aborted, ...closedBrokers].filter(result => result.status === "rejected").map(result => String(result.reason)) });
      // Preparation rejection is expected on cancellation; explicit runtime abort
      // failures are not hidden by the registry's best-effort disposal.
      const failures = [...aborted, ...closedBrokers].filter(result => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Live Pi runtime cleanup failed");
    })();
    return closing;
  };
  const onAbort = () => {
    cancellation.abort(options.signal.reason);
    // Initialization owns cleanup until it has finished assigning its resources.
    if (initialized) void close().catch(() => { /* The caller's close() observes cleanup failures. */ });
  };
  options.signal.addEventListener("abort", onAbort, { once: true });

  try {
    signal.throwIfAborted();
    await mkdir(agentDir);
    const credentials = new InMemoryCredentialStore();
    // This is the production consent marker, not a backend OAuth token.
    await credentials.modify("agy", async () => createAgyBridgeCredential("acp"));
    const modelRuntime = await ModelRuntime.create({
      credentials, modelsPath: null, modelsStorePath: path.join(scratch, "models-store.json"),
      refreshOnCreate: false, signal,
    });
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false },
      images: { autoResize: false, blockImages: false },
      compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 8192 },
      cacheWarming: "off",
    });
    const driver = new AcpDriver(async () => options.launch);
    const prepare = driver.prepareSession.bind(driver);
    driver.prepareSession = input => {
      liveSessions.add(input.session);
      const pending = (async () => {
        signal.throwIfAborted();
        try {
          const runtime = await prepare({ ...input, options: { ...input.options,
            signal: input.options?.signal ? AbortSignal.any([input.options.signal, signal]) : signal,
          } });
          runtimes.add(runtime.proc);
          brokers.add(runtime.mcpServer);
          return runtime;
        } finally {
          if (input.session.activeProcess) runtimes.add(input.session.activeProcess);
          if (input.session.activeMcpServer) brokers.add(input.session.activeMcpServer);
        }
      })();
      preparations.add(pending);
      void pending.finally(() => preparations.delete(pending)).catch(() => {});
      return pending;
    };
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      // These also disable SYSTEM.md / APPEND_SYSTEM.md discovery.
      systemPrompt: "You are a helpful assistant.", appendSystemPrompt: [],
      extensionFactories: [pi => {
        pi.registerTool(options.tool);
        bridge = new Bridge(pi, driver);
        bridge.start();
      }],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, [], "Live Pi inline extension must load without errors");
    signal.throwIfAborted();
    ({ session } = await createAgentSession({
      cwd: options.cwd, agentDir, model: options.model, modelRuntime, settingsManager, resourceLoader,
      sessionManager: SessionManager.create(options.cwd, path.join(scratch, "sessions")),
      tools: [options.tool.name],
      sessionStartEvent: { type: "session_start", reason: "new" },
    }));
    assert.ok(bridge, "Inline Bridge extension did not load");
    // bindExtensions() emits session_start, whose Bridge handler unconditionally
    // requests allowNetwork:true discovery even for reason:new. Core/tool bindings
    // already exist after createAgentSession; only the manager association is needed.
    bridge.piContextAdapter.bind(session.sessionManager);
    signal.throwIfAborted();
    initialized = true;
    return { session, bridge, close };
  } catch (error) {
    await close();
    throw error;
  }
}
