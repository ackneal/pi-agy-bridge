import os from "node:os";
import path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AnyModel,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  Tool,
} from "@earendil-works/pi-ai";
import { getCurrentTools, isModelType, normalizeContext } from "@earendil-works/pi-ai";
import { PiEventAdapter } from "../runtime/events.ts";
import { AgyRuntime } from "../runtime/process.ts";
import { BridgeIPC } from "../bridge/bridge-ipc.ts";
import { AgyTurn } from "./turn.ts";
import {
  LiveSessionRegistry,
  PiContextAdapter,
  calculateSyncKey,
  type LiveSession,
} from "../session/session.ts";
import { RuntimeSessionStore, RuntimeSessionSync } from "../session/session-state.ts";
import { DEFAULT_AGY_PLUGIN_DIR, ensureAgyPluginInstalled } from "../discovery/plugin-install.ts";
import { validateAgyVersion } from "../runtime/version.ts";
import { discoverAgyModels, restoreStoredAgyModels } from "../discovery/models.ts";
import { debugArtifact, debugLog } from "../shared/debug.ts";
import type { AgyBridgeConfig } from "../shared/types.ts";
import { collectDoctorReport, type DoctorFailure } from "./doctor.ts";
import { AgyAuthentication, getAgyBridgeAuthEnvironment, isAgyBridgeEnabled } from "./auth.ts";
import { autoConfigureAgyAuthentication } from "./startup-auth.ts";

function formatMessageText(message: Message): string {
  if (typeof message.content === "string") return message.content;

  return message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return `[Image: ${block.mimeType}]`;
      if (block.type === "toolCall") {
        return `[Tool Call: ${block.name}(${JSON.stringify(block.arguments)})]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function formatContextPrompt(context: Context, isReused: boolean, syncedMessageCount?: number): string {
  const currentMessage = context.messages.at(-1);
  if (isReused) {
    const messages = context.messages.slice(syncedMessageCount ?? Math.max(0, context.messages.length - 1));
    if (messages.length === 0) return "";
    const message = messages[0]!;
    if (messages.length === 1 && message.role === "user" &&
        (typeof message.content === "string" || message.content.every((block) => block.type === "text"))) {
      return formatMessageText(message);
    }
    return formatContextUpdate(messages, "incremental_conversation");
  }

  const latestRunStart = findLatestRunStart(context.messages);
  const history = context.messages.slice(0, -1)
    .map((message, index) => index < latestRunStart && message.role === "toolResult"
      ? formatOmittedToolResult(message)
      : formatJsonMessage(message));
  const reconstructedContext: Record<string, unknown> = {
    purpose: "reconstructed_conversation",
    ...(context.systemPrompt ? { systemInstructions: context.systemPrompt } : {}),
    history,
    ...(currentMessage ? { currentMessage: formatJsonMessage(currentMessage) } : {}),
  };

  return JSON.stringify(reconstructedContext);
}

function formatContextUpdate(
  messages: readonly Message[],
  purpose: "incremental_conversation" | "pending_tool_continuation",
): string {
  return JSON.stringify({ purpose, messages: messages.map(formatJsonMessage) });
}

function findLatestRunStart(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant" && message.stopReason !== "toolUse") return index + 1;
  }
  return 0;
}

function formatOmittedToolResult(message: Extract<Message, { role: "toolResult" }>): Record<string, unknown> {
  return {
    role: message.role,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    isError: message.isError,
    contentOmitted: true,
  };
}

function formatJsonMessage(message: Message): Record<string, unknown> {
  const formatted: Record<string, unknown> = {
    role: message.role,
    content: formatJsonContent(message),
  };
  if (message.role === "toolResult") {
    formatted.toolCallId = message.toolCallId;
    formatted.toolName = message.toolName;
    formatted.isError = message.isError;
  }
  if (message.role === "assistant") {
    formatted.stopReason = message.stopReason;
    if (message.errorMessage !== undefined) formatted.errorMessage = message.errorMessage;
  }
  if (message.role === "system" && message.sections && Object.keys(message.sections).length > 0) {
    formatted.sections = message.sections;
  }
  return formatted;
}

function formatJsonContent(message: Message): unknown {
  if (typeof message.content === "string") return message.content;

  const content: unknown[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      content.push({ type: "image", mimeType: block.mimeType, data: block.data });
    } else if (block.type === "toolCall") {
      content.push({
        type: "toolCall",
        id: block.id,
        name: block.name,
        ...(block.namespace !== undefined ? { namespace: block.namespace } : {}),
        arguments: block.arguments,
      });
    }
  }
  return content;
}

export function resolveModelAndEffort(
  modelId: string,
  options?: SimpleStreamOptions,
  thinkingLevelMap?: Model<any>["thinkingLevelMap"],
): { baseModel: string; effort?: "low" | "medium" | "high" | undefined } {
  const requested =
    (options as any)?.reasoningEffort ??
    (options as any)?.reasoning ??
    (options as any)?.thinkingLevel;

  let effort: "low" | "medium" | "high" | undefined;
  if (requested === "low" || requested === "medium" || requested === "high") {
    effort = requested;
  } else if (requested !== undefined) {
    throw new Error(`Unsupported Antigravity CLI reasoning effort: ${String(requested)}. Supported values: low, medium, high.`);
  }

  let baseModel = modelId;
  const match = modelId.match(/^(.+)-(low|medium|high)$/i);
  if (match?.[1]) {
    baseModel = match[1];
    if (!effort) {
      effort = match[2]?.toLowerCase() as "low" | "medium" | "high" | undefined;
    }
  }

  if (effort && thinkingLevelMap?.[effort] === null) {
    throw new Error(`Unsupported Antigravity CLI reasoning effort for ${modelId}: ${effort}.`);
  }

  return { baseModel, effort };
}

function expandHome(filepath: string): string {
  if (filepath.startsWith("~/") || filepath === "~") {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

async function prepareRuntime(
  model: Model<any>,
  context: Context,
  tools: readonly Tool[],
  options: SimpleStreamOptions | undefined,
  config: AgyBridgeConfig | undefined,
  bridge: AgyBridge,
  liveSession: LiveSession,
  selection: ReturnType<typeof resolveModelAndEffort>,
  preparationId: symbol,
): Promise<{ proc: AgyRuntime; mcpServer: BridgeIPC; reconstructContext: boolean; modelId: string }> {
  const checkPreparation = () => {
    options?.signal?.throwIfAborted();
    if (!liveSession.ownsPreparation(preparationId)) {
      throw new Error("Antigravity CLI runtime preparation was superseded");
    }
  };
  checkPreparation();

  const { baseModel, effort } = selection;
  const agentName = config?.agentName ?? "pi-bridge";
  const toolSyncValues = tools.map((tool) => JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  const syncKey = calculateSyncKey(context.systemPrompt ?? "", toolSyncValues, baseModel, effort ?? "", agentName);
  const latestAssistant = [...context.messages].reverse().find((message) => message.role === "assistant");
  const expectedConversationId = latestAssistant?.role === "assistant" ? latestAssistant.responseId : undefined;
  const rawPluginDir = config?.pluginDir ?? config?.agentDir;
  const pluginDir = rawPluginDir ? path.resolve(expandHome(rawPluginDir)) : DEFAULT_AGY_PLUGIN_DIR;
  const checkpoint = await bridge.runtimeSessionStore.get(liveSession.piSessionId, options?.env?.AGY_BRIDGE_LOGIN_EPOCH);
  checkPreparation();
  const decision = bridge.runtimeSessionSync.decide(liveSession, {
    syncKey,
    ...(expectedConversationId ? { conversationId: expectedConversationId } : {}),
    messages: context.messages,
    ...(checkpoint ? { checkpoint } : {}),
  });

  debugLog("register", "Antigravity CLI runtime decision", {
    action: decision.action,
    messageCount: context.messages.length,
    syncedMessageCount: bridge.runtimeSessionSync.getSyncedMessageCount(liveSession),
    processRunning: liveSession.activeProcess?.isRunning ?? false,
    sessionConversationId: liveSession.conversationId,
    expectedConversationId,
    hasActiveProcess: liveSession.activeProcess !== null,
  });

  if (decision.action === "continue" && liveSession.activeProcess) {
    debugLog("register", "Reusing existing Antigravity CLI process");
    if (!liveSession.activeMcpServer) {
      throw new Error("Antigravity CLI process or Pi MCP bridge was not initialized");
    }
    const proc = liveSession.activeProcess;
    const modelMatches = proc.options.model === baseModel && proc.options.effort === effort;
    if (liveSession.syncKey !== syncKey) {
      debugLog("session", "Deferring runtime settings change until the pending Antigravity CLI turn finishes", {
        activeModel: proc.options.model,
        requestedModel: baseModel,
      });
    }
    return {
      proc,
      mcpServer: liveSession.activeMcpServer,
      reconstructContext: false,
      modelId: modelMatches ? model.id : latestAssistant?.model ?? proc.options.model,
    };
  }

  debugLog("register", "Starting a replacement Antigravity CLI process");
  debugLog("session", "Replacing Antigravity CLI runtime", {
    action: decision.action,
    conversationId: liveSession.conversationId,
    hasPendingCalls: liveSession.activeMcpServer?.hasPendingCalls ?? false,
  });
  await liveSession.dispose({
    preserveConversation: decision.action === "resume",
    preserveResources: decision.action === "resume" && decision.conversationId === liveSession.conversationId,
    preparationId,
  });
  checkPreparation();
  await validateAgyVersion(config?.agyPath, config?.minVersion);
  checkPreparation();

  const startRuntime = async (conversationId?: string) => {
    const mcpServer = new BridgeIPC(tools, liveSession.id, liveSession.resources);
    let proc: AgyRuntime | null = null;
    const abortStartup = () => {
      void mcpServer.close().catch((error) => debugLog("session", "Error closing cancelled MCP startup:", error));
      void proc?.abort().catch((error) => debugLog("session", "Error aborting cancelled Antigravity CLI startup:", error));
    };
    options?.signal?.addEventListener("abort", abortStartup, { once: true });
    try {
      checkPreparation();
      await mcpServer.start();
      checkPreparation();
      await bridge.ensureAgyPluginInstalled(pluginDir);
      checkPreparation();
      proc = new AgyRuntime({
        agyPath: config?.agyPath,
        agentName,
        model: baseModel,
        conversationId,
        effort,
        environment: mcpServer.processEnvironment,
      });
      const initEvent = await proc.start();
      checkPreparation();
      debugLog("register", "Antigravity CLI init conversation id:", initEvent.conversation_id);
      if (conversationId && initEvent.conversation_id !== conversationId) {
        throw new Error("Antigravity CLI did not restore the requested conversation");
      }
      if (!proc.isRunning) throw new Error("Antigravity CLI exited before input delivery");
      if (!liveSession.setSession(proc, syncKey, mcpServer, initEvent.conversation_id, preparationId)) {
        throw new Error("Antigravity CLI runtime preparation was superseded");
      }
      return { proc, mcpServer, modelId: model.id };
    } catch (error) {
      // Ownership transfers to liveSession only after startup succeeds.
      await mcpServer.close().catch((cleanupError) => {
        debugLog("session", "Error closing unowned MCP bridge:", cleanupError);
      });
      if (proc) {
        await proc.abort().catch((cleanupError) => {
          debugLog("session", "Error aborting unowned Antigravity CLI process:", cleanupError);
        });
      }
      throw error;
    } finally {
      options?.signal?.removeEventListener("abort", abortStartup);
    }
  };

  if (decision.action === "resume") {
    try {
      return { ...await startRuntime(decision.conversationId), reconstructContext: false };
    } catch (error) {
      checkPreparation();
      debugLog("session", "Conversation resume failed before input delivery; rebuilding once", {
        conversationId: decision.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      await bridge.runtimeSessionStore.delete(liveSession.piSessionId).catch((failure) => {
        debugLog("session", "Could not invalidate rejected conversation reference:", failure);
      });
      checkPreparation();
      liveSession.resources.disposeAll();
    }
  }

  return { ...await startRuntime(), reconstructContext: true };
}

export function streamAgyProvider(
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: AgyBridgeConfig | undefined,
  bridge: AgyBridge
): AssistantMessageEventStream {
  debugArtifact("provider-context", { model: model.id, sessionId: options?.sessionId, context });
  const contextTools = context.tools ?? [];
  const tools = bridge.getTools(context);
  debugLog("mcp", "Pi provider context keys:", Object.keys(context));
  debugLog("mcp", "Pi provider context tools:", contextTools.map((tool) => tool.name));
  debugLog("mcp", "Pi bridge tools:", tools.map((tool) => tool.name));
  const bridgeToolNameSet = new Set(tools.map((tool) => tool.name));
  const adapter = new PiEventAdapter({
    model: model.id,
    provider: model.provider ?? "agy",
    allowedToolNames: bridgeToolNameSet,
    bridgeToolCallsExternally: true,
  });
  const stream = adapter.stream;

  if (options?.signal?.aborted) {
    adapter.handleTermination("aborted", "Request was aborted before execution started");
    return stream;
  }

  const piSessionId = options?.sessionId;
  if (!piSessionId) {
    adapter.handleTermination("error", "Pi did not provide a sessionId for the Antigravity CLI runtime");
    return stream;
  }

  let selection: ReturnType<typeof resolveModelAndEffort>;
  try {
    selection = resolveModelAndEffort(model.id, options, model.thinkingLevelMap);
  } catch (error) {
    adapter.handleTermination("error", error instanceof Error ? error.message : String(error));
    return stream;
  }

  const liveSession = bridge.liveSessions.getOrCreate(piSessionId);
  adapter.setErrorState(liveSession.errorState);
  const preparationId = liveSession.beginPreparation();
  const turn = new AgyTurn({
    session: liveSession,
    adapter,
    context,
    sync: bridge.runtimeSessionSync,
    store: bridge.runtimeSessionStore,
    preparationId,
    signal: options?.signal,
    loginEpoch: options?.env?.AGY_BRIDGE_LOGIN_EPOCH,
  });

  (async () => {
    try {
      const runtime = await prepareRuntime(model, context, tools, options, config, bridge, liveSession, selection, preparationId);
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
        ? formatContextUpdate(contextUpdates, "pending_tool_continuation")
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
        throw new Error("Antigravity CLI is waiting for Pi tool results, but no matching result was returned");
      }

      turn.openToolDispatch();

      let prompt = formatContextPrompt(context, !runtime.reconstructContext, syncedMessageCount);
      if (options?.onPayload) {
        try {
          const payload = { prompt };
          const rewritten = await options.onPayload(payload, model);
          if (rewritten && typeof rewritten === "object" && "prompt" in rewritten) {
            prompt = (rewritten as { prompt: string }).prompt;
          }
        } catch (err) {
          debugLog("register", "Error in options.onPayload:", err);
        }
      }

      debugArtifact("agy-payload", {
        sessionId: piSessionId,
        conversationId: liveSession.conversationId,
        reconstructContext: runtime.reconstructContext,
        prompt,
      });
      await turn.send({ event: "user", message: { content: prompt } });
    } catch (error) {
      turn.fail(error);
    }
  })().catch((error) => {
    debugLog("session", "Antigravity CLI turn cleanup failed:", error);
  });

  return stream;
}

export class AgyBridge {
  private readonly pi: ExtensionAPI;
  private readonly config: AgyBridgeConfig | undefined;
  private pluginError: DoctorFailure | undefined;
  private discoveryError: DoctorFailure | undefined;
  private readonly authentication: AgyAuthentication;
  private startupAuthenticationStarted = false;
  private runtimeLifetime = new AbortController();
  private readonly sessionIds = new Set<string>();
  public readonly liveSessions = new LiveSessionRegistry();
  public readonly runtimeSessionSync = new RuntimeSessionSync();
  public readonly piContextAdapter = new PiContextAdapter();
  public readonly runtimeSessionStore = new RuntimeSessionStore(this.piContextAdapter);

  constructor(pi: ExtensionAPI, config?: AgyBridgeConfig) {
    this.pi = pi;
    this.config = config;
    this.authentication = new AgyAuthentication(config?.agyPath, async () => {
      this.runtimeLifetime.abort(new Error("Antigravity CLI login changed the bridge session"));
      await this.liveSessions.disposeAll();
      for (const sessionId of this.sessionIds) {
        if (this.piContextAdapter.getSessionManager(sessionId)) {
          await this.runtimeSessionStore.delete(sessionId);
        }
      }
      this.runtimeLifetime = new AbortController();
    });
  }

  public async ensureAgyPluginInstalled(pluginDir: string): Promise<void> {
    try {
      await ensureAgyPluginInstalled(this.config?.agyPath, pluginDir);
      this.pluginError = undefined;
    } catch (error) {
      this.pluginError = {
        time: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
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
    let models: AnyModel[] = (this.config?.models ?? []).map((model) => ({
      ...model,
      provider: "agy",
      api: model.api ?? "agy",
      baseUrl: model.baseUrl ?? "agy",
      type: model.type ?? "chat",
    })) as AnyModel[];

    this.pi.registerCommand("agy-bridge:doctor", {
      description: "Check Antigravity CLI CLI, plugin installation, models, and MCP",
      handler: async () => {
        const rawPluginDir = this.config?.pluginDir ?? this.config?.agentDir;
        const report = await collectDoctorReport({
          agyPath: this.config?.agyPath,
          minVersion: this.config?.minVersion,
          pluginDir: rawPluginDir ? path.resolve(expandHome(rawPluginDir)) : DEFAULT_AGY_PLUGIN_DIR,
          models: this.config?.models,
          catalogModels: models,
          pluginError: this.pluginError,
          discoveryError: this.discoveryError,
          authStatus: this.authentication.status,
          authError: this.authentication.failure,
        });
        this.pi.sendMessage({
          customType: "pi-agy-bridge:doctor",
          content: report,
          display: true,
        }, { triggerTurn: false });
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
            const authPath = this.config?.authPath ?? path.join(getAgentDir(), "auth.json");
            await autoConfigureAgyAuthentication(this.authentication, authPath, lifetime);
          } catch (error) {
            debugLog("auth", "Antigravity CLI startup auto-configuration skipped:", error);
          }
        }
        if (lifetime.aborted) return;

        try {
          await ctx.modelRegistry.refresh({ providers: ["agy"], allowNetwork: true });
        } catch (error) {
          debugLog("discovery", "Antigravity CLI background model refresh failed:", error);
        }
      })();
    });
    this.pi.on("session_shutdown", async () => {
      this.authentication.close();
      this.runtimeLifetime.abort(new Error("Antigravity CLI bridge session ended"));
      await this.liveSessions.disposeAll();
      this.piContextAdapter.clear();
      this.sessionIds.clear();
    });

    const stream = (model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
      const oauthEnvironment = getAgyBridgeAuthEnvironment(options?.apiKey);
      const env = { ...options?.env, ...oauthEnvironment };
      if (env.AGY_BRIDGE_ENABLED !== "1") {
        const adapter = new PiEventAdapter({ model: model.id, provider: "agy" });
        adapter.handleTermination("error", "Antigravity CLI disabled in Pi");
        return adapter.stream;
      }
      const signal = options?.signal
        ? AbortSignal.any([options.signal, this.runtimeLifetime.signal])
        : this.runtimeLifetime.signal;
      return streamAgyProvider(model, context, { ...options, env, signal }, this.config, this);
    };

    this.pi.registerProvider({
      id: "agy",
      name: "Antigravity CLI [pi-agy-bridge]",
      baseUrl: "agy",
      auth: { oauth: this.authentication.oauth, apiKey: this.authentication.method },
      getModels: () => models.filter((model) => isModelType(model, "chat")),
      getAllModels: () => models,
      filterModels: (catalog, credential) => isAgyBridgeEnabled(credential) ? catalog : [],
      filterAllModels: (catalog, credential) => isAgyBridgeEnabled(credential) ? catalog : [],
      ...(this.config?.models ? {} : {
        refreshModels: async (context) => {
          if (context.signal.aborted) return;

          if (context.stored) {
            const restored = restoreStoredAgyModels(context.stored.models);
            const accepted = await context.publish({ update: () => { models = restored; } });
            if (!accepted) return;
          }
          if (!context.allowNetwork) return;

          try {
            const discovered = await discoverAgyModels(this.config?.agyPath, context.signal);
            await context.publish({
              persist: { models: discovered },
              update: () => {
                models = discovered;
                this.discoveryError = undefined;
              },
            });
          } catch (error) {
            if (context.signal.aborted) throw error;
            this.discoveryError = {
              time: new Date().toISOString(),
              message: error instanceof Error ? error.message : String(error),
            };
            debugLog("models", "Model refresh failed; retaining cached models:", error);
          }
        },
      }),
      stream: (model, context, options) => stream(model, context, options as SimpleStreamOptions),
      streamSimple: stream,
    });
  }
}

export function registerAgyProvider(
  pi: ExtensionAPI,
  config?: AgyBridgeConfig
): void {
  new AgyBridge(pi, config).start();
}
