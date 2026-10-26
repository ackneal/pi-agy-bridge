import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AnyModel,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  Tool,
} from "@earendil-works/pi-ai";
import { getCurrentTools, isModelType, normalizeContext } from "@earendil-works/pi-ai";
import { PiRuntimeOutput } from "./output.ts";
import { restoreStoredAgyModels } from "../discovery/models.ts";
import { Turn } from "./turn.ts";
import {
  LiveSessionRegistry,
  PiContextAdapter,
} from "../session/session.ts";
import { RuntimeSessionStore, RuntimeSessionSync } from "../session/state.ts";
import type { AgyUsage } from "../runtime/usage.ts";
import { createBridgeDriver } from "../drivers/driver.ts";
import type { BridgeDriver, DriverFailure, DriverId } from "../drivers/types.ts";
import { debugArtifact, debugLog } from "../shared/debug.ts";
import { AgyAuthentication, getAgyBridgeAuthEnvironment, isAgyBridgeEnabled } from "./auth.ts";
import { autoConfigureAgyAuthentication } from "./startup-auth.ts";

export function streamAgyProvider(
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  bridge: Bridge
): AssistantMessageEventStream {
  debugArtifact("provider-context", { model: model.id, sessionId: options?.sessionId, context });
  const contextTools = context.tools ?? [];
  const tools = bridge.getTools(context);
  debugLog("mcp", "Pi provider context keys:", Object.keys(context));
  debugLog("mcp", "Pi provider context tools:", contextTools.map((tool) => tool.name));
  debugLog("mcp", "Pi bridge tools:", tools.map((tool) => tool.name));
  const bridgeToolNameSet = new Set(tools.map((tool) => tool.name));
  const adapter = new PiRuntimeOutput({
    model: model.id,
    provider: model.provider ?? "agy",
    allowedToolNames: bridgeToolNameSet,
  });
  const stream = adapter.stream;

  if (options?.signal?.aborted) {
    adapter.handleTermination("aborted", "Request was aborted before execution started");
    return stream;
  }

  const piSessionId = options?.sessionId;
  if (!piSessionId) {
    adapter.handleTermination("error", `Pi did not provide a sessionId for the ${bridge.driver.label} runtime`);
    return stream;
  }

  try {
    bridge.driver.validateSelection(model, options);
  } catch (error) {
    adapter.handleTermination("error", error instanceof Error ? error.message : String(error));
    return stream;
  }

  const liveSession = bridge.liveSessions.getOrCreate(piSessionId);
  const preparationId = liveSession.beginPreparation();
  const turn = new Turn({
    session: liveSession,
    adapter,
    context,
    sync: bridge.runtimeSessionSync,
    store: bridge.runtimeSessionStore,
    preparationId,
    signal: options?.signal,
    loginEpoch: options?.env?.AGY_BRIDGE_LOGIN_EPOCH,
    sessionVersion: bridge.driver.sessionVersion,
  });

  (async () => {
    try {
      const runtime = await bridge.driver.prepareSession({
        model, context, tools, options, session: liveSession, preparationId,
        store: bridge.runtimeSessionStore, sync: bridge.runtimeSessionSync,
      });
      const mcpServer = runtime.mcpServer;
      adapter.setModel(runtime.modelId);
      turn.attach(runtime);
      if (adapter.isCompleted()) return;

      const syncedMessageCount = runtime.reconstructContext ? 0 :
        bridge.runtimeSessionSync.getSyncedMessageCount(liveSession) ?? Math.max(0, context.messages.length - 1);
      const newMessages = context.messages.slice(syncedMessageCount);
      const toolResults = newMessages.filter((message) => message.role === "toolResult");
      const contextUpdates = newMessages.filter((message) => message.role !== "toolResult");
      // A stdin prompt starts another AGY turn. Carry updates with the pending MCP
      // response instead so the current turn sees them before resuming.
      const hasPendingCalls = mcpServer.hasPendingCalls;
      const contextUpdate = hasPendingCalls && contextUpdates.length > 0
        ? runtime.proc.formatContextUpdate(contextUpdates)
        : undefined;
      const enqueuedToolResults = hasPendingCalls
        ? mcpServer.resolveToolResults(toolResults, contextUpdate)
        : 0;
      if (enqueuedToolResults > 0) {
        await turn.recordAcceptedContext();
        // Installing a handler can immediately dispatch calls queued during the
        // preceding Pi turn. Record its results before opening the next batch.
        turn.openToolDispatch();
        return;
      }

      if (mcpServer.hasPendingCalls) {
        throw new Error(`${bridge.driver.label} is waiting for Pi tool results, but no matching result was returned`);
      }

      turn.openToolDispatch();

      await turn.send({ model, context, options, reconstructContext: runtime.reconstructContext, syncedMessageCount });
    } catch (error) {
      turn.fail(error);
    }
  })().catch((error) => {
    debugLog("session", `${bridge.driver.label} turn cleanup failed:`, error);
  });

  return stream;
}

export class Bridge {
  private readonly pi: ExtensionAPI;
  private models: AnyModel[] = [];
  public driver: BridgeDriver;
  private discoveryError: DriverFailure | undefined;
  private usageError: DriverFailure | undefined;
  private usageRefresh: Promise<AgyUsage | undefined> | undefined;
  private readonly authentication: AgyAuthentication;
  private startupAuthenticationStarted = false;
  private runtimeLifetime = new AbortController();
  private readonly lifetime = new AbortController();
  private readonly sessionIds = new Set<string>();
  public readonly liveSessions = new LiveSessionRegistry();
  public readonly runtimeSessionSync = new RuntimeSessionSync();
  public readonly piContextAdapter = new PiContextAdapter();
  public readonly runtimeSessionStore = new RuntimeSessionStore(this.piContextAdapter);

  constructor(pi: ExtensionAPI, driver?: BridgeDriver) {
    this.pi = pi;
    this.driver = driver ?? createBridgeDriver("acp");
    this.authentication = new AgyAuthentication(this.driver.authentication, async () => {
      this.runtimeLifetime.abort(new Error(`${this.driver.label} login changed the bridge session`));
      this.usageRefresh = undefined;
      await this.liveSessions.disposeAll();
      for (const sessionId of this.sessionIds) {
        if (this.piContextAdapter.getSessionManager(sessionId)) {
          await this.runtimeSessionStore.delete(sessionId);
        }
      }
      this.runtimeLifetime = new AbortController();
    });
  }

  private async refreshUsage(signal: AbortSignal): Promise<AgyUsage | undefined> {
    if (signal.aborted) return undefined;
    if (this.usageRefresh) return this.usageRefresh;

    const task = this.driver.usage(signal)
      .then((usage) => {
        if (signal.aborted) return undefined;
        this.authentication.usage = usage;
        this.usageError = undefined;
        if (usage) {
          this.authentication.status = "authenticated";
          this.authentication.failure = undefined;
        }
        return usage;
      })
      .catch((error) => {
        if (!signal.aborted) {
          this.authentication.usage = undefined;
          this.usageError = {
            time: new Date().toISOString(),
            message: error instanceof Error ? error.message : String(error),
          };
          debugLog("usage", `${this.driver.label} usage check failed:`, error);
        }
        return undefined;
      })
      .finally(() => {
        if (this.usageRefresh === task) this.usageRefresh = undefined;
      });

    this.usageRefresh = task;
    return task;
  }

  public async switchDriver(driverId: DriverId, modelRegistry?: ExtensionContext["modelRegistry"]): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    if (this.driver.id === driverId) return;

    const driver = createBridgeDriver(driverId);
    if (!driver.detectExecutable()) throw new Error(`${driver.label} executable not found`);
    const lifetime = this.runtimeLifetime.signal;
    const models = await driver.discoverModels(lifetime);
    lifetime.throwIfAborted();

    this.runtimeLifetime.abort(new Error("Antigravity bridge driver changed"));
    await this.liveSessions.disposeAll();
    this.lifetime.signal.throwIfAborted();
    if (this.runtimeLifetime.signal !== lifetime) throw new Error("Antigravity driver switch was superseded");

    this.driver = driver;
    this.authentication.setBackend(driver.authentication);
    this.runtimeLifetime = new AbortController();

    this.usageRefresh = undefined;
    this.discoveryError = undefined;
    this.usageError = undefined;

    this.registerProvider(models);
    await modelRegistry?.refresh({ providers: ["agy"], allowNetwork: false });

    debugLog("provider", `Switched bridge driver to: ${this.driver.label} (${driverId})`);
  }

  public getTools(context: Context): Tool[] {
    // Pi 0.99.2 carries model-facing tool declarations in system-message deltas.
    if (context.tools !== undefined || context.messages.some((message) => message.role === "system")) {
      return getCurrentTools(normalizeContext(context).messages);
    }

    const activeTools = new Set(this.pi.getActiveTools());
    return this.pi.getAllTools().filter((tool) => activeTools.has(tool.name) && tool.exposure !== "hidden");
  }

  public start(): void {
    this.pi.registerCommand("agy-bridge:doctor", {
      description: "Check the selected Antigravity driver, models, tools, authentication, and quota",
      handler: async () => {
        const lifetime = this.runtimeLifetime.signal;
        const usage = await this.refreshUsage(lifetime);
        if (lifetime.aborted) return;

        const report = await this.driver.doctor({
          catalogModels: this.models,
          discoveryError: this.discoveryError,
          authStatus: this.authentication.status,
          authError: this.authentication.failure,
          usage,
          usageError: this.usageError,
        });
        if (lifetime.aborted) return;

        this.pi.sendMessage({
          customType: "pi-agy-bridge:doctor",
          content: report,
          display: true,
        }, { triggerTurn: false });
      },
    });

    this.pi.registerCommand("agy-bridge:driver", {
      description: "Show or switch the Antigravity driver (/agy-bridge:driver [cli|acp])",
      handler: async (args, ctx) => {
        const target = args?.trim().toLowerCase();
        if (!target) {
          const acpPath = createBridgeDriver("acp").detectExecutable();
          const cliPath = createBridgeDriver("cli").detectExecutable();
          const status = [
            `Current driver: **${this.driver.label}** (${this.driver.id})`,
            "Default: ACP. Driver changes are explicit; automatic fallback is disabled.",
            "",
            "Available drivers:",
            `- **acp**: ${acpPath ? `✓ Found (${acpPath})` : "✗ Not found"}`,
            `- **cli**: ${cliPath ? `✓ Found (${cliPath})` : "✗ Not found"}`,
            "",
            "Usage: `/agy-bridge:driver cli` or `/agy-bridge:driver acp`",
          ].join("\n");

          this.pi.sendMessage({
            customType: "pi-agy-bridge:driver",
            content: status,
            display: true,
          }, { triggerTurn: false });
          return;
        }

        if (target !== "cli" && target !== "acp") {
          this.pi.sendMessage({
            customType: "pi-agy-bridge:driver",
            content: `Unknown driver "${target}". Available: cli, acp.`,
            display: true,
          }, { triggerTurn: false });
          return;
        }

        if (target === this.driver.id) {
          this.pi.sendMessage({
            customType: "pi-agy-bridge:driver",
            content: `Already using driver: **${this.driver.label}** (${target}).`,
            display: true,
          }, { triggerTurn: false });
          return;
        }

        try {
          await this.switchDriver(target, ctx?.modelRegistry);
          this.pi.sendMessage({
            customType: "pi-agy-bridge:driver",
            content: `Successfully switched driver to **${this.driver.label}** (${target}).`,
            display: true,
          }, { triggerTurn: false });
        } catch (error) {
          this.pi.sendMessage({
            customType: "pi-agy-bridge:driver",
            content: `Failed to switch driver: ${error instanceof Error ? error.message : String(error)}`,
            display: true,
          }, { triggerTurn: false });
        }
      },
    });

    this.pi.on("session_start", (event, ctx) => {
      this.sessionIds.add(this.piContextAdapter.bind(ctx.sessionManager));
      const lifetime = this.runtimeLifetime.signal;
      const autoConfigure = event.reason === "startup" && !this.startupAuthenticationStarted;
      if (autoConfigure) this.startupAuthenticationStarted = true;

      void (async () => {
        if (autoConfigure) {
          try {
            const authPath = path.join(getAgentDir(), "auth.json");
            await autoConfigureAgyAuthentication(this.authentication, authPath, lifetime);
          } catch (error) {
            debugLog("auth", `${this.driver.label} startup auto-configuration skipped:`, error);
          }
        }
        if (lifetime.aborted) return;

        try {
          await ctx.modelRegistry.refresh({ providers: ["agy"], allowNetwork: true });
        } catch (error) {
          debugLog("discovery", `${this.driver.label} background model refresh failed:`, error);
        }
      })();
    });
    this.pi.on("session_shutdown", async () => {
      this.lifetime.abort(new Error("Antigravity bridge session ended"));
      this.authentication.close();
      this.runtimeLifetime.abort(new Error(`${this.driver.label} bridge session ended`));
      await this.liveSessions.disposeAll();
      this.piContextAdapter.clear();
      this.sessionIds.clear();
    });

    this.registerProvider();
  }

  private registerProvider(models?: readonly AnyModel[]): void {
    const driver = this.driver;
    this.models = (models ?? driver.initialModels).map((model) => ({
      ...model,
      provider: "agy",
      api: model.api ?? "agy",
      baseUrl: model.baseUrl ?? "agy",
      type: model.type ?? "chat",
    })) as AnyModel[];

    const stream = (model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
      const oauthEnvironment = getAgyBridgeAuthEnvironment(options?.apiKey);
      const env = { ...options?.env, ...oauthEnvironment };
      if (env.AGY_BRIDGE_ENABLED !== "1") {
        const adapter = new PiRuntimeOutput({ model: model.id, provider: "agy" });
        adapter.handleTermination("error", `${this.driver.label} disabled in Pi`);
        return adapter.stream;
      }
      const signal = options?.signal
        ? AbortSignal.any([options.signal, this.runtimeLifetime.signal])
        : this.runtimeLifetime.signal;
      return streamAgyProvider(model, context, { ...options, env, signal }, this);
    };

    this.pi.registerProvider({
      id: "agy",
      name: `${this.driver.label} [pi-agy-bridge]`,
      baseUrl: "agy",
      auth: { oauth: this.authentication.oauth, apiKey: this.authentication.method },
      getModels: () => this.models.filter((model) => isModelType(model, "chat")),
      getAllModels: () => this.models,
      filterModels: (catalog, credential) => isAgyBridgeEnabled(credential) ? catalog : [],
      filterAllModels: (catalog, credential) => isAgyBridgeEnabled(credential) ? catalog : [],
      refreshModels: async (context) => {
        const signal = AbortSignal.any([context.signal, this.runtimeLifetime.signal]);
        if (signal.aborted || driver !== this.driver) return;

        if (context.stored && models === undefined) {
          const restored = restoreStoredAgyModels(context.stored.models);
          if (restored.length > 0) {
            const accepted = await context.publish({ update: () => { if (!signal.aborted) this.models = restored; } });
            if (!accepted) return;
          }
        }
        if (!context.allowNetwork || signal.aborted) return;

        try {
          const discovered = await driver.discoverModels(signal);
          if (signal.aborted) return;
          await context.publish({
            persist: { models: discovered },
            update: () => {
              if (signal.aborted) return;
              this.models = discovered;
              this.discoveryError = undefined;
            },
          });
        } catch (error) {
          if (signal.aborted) throw error;
          this.discoveryError = {
            time: new Date().toISOString(),
            message: error instanceof Error ? error.message : String(error),
          };
          debugLog("models", "Model refresh failed; retaining cached models:", error);
        }
      },
      stream: (model, context, options) => stream(model, context, options as SimpleStreamOptions),
      streamSimple: stream,
    });
  }
}

export function registerAgyProvider(pi: ExtensionAPI): void {
  new Bridge(pi).start();
}
