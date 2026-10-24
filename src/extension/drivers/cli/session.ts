import path from "node:path";
import type { Context, Model, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import { CliRuntimeSession } from "./runtime.ts";
import type { ConversationErrorState } from "./events.ts";
import { BridgeIPC } from "../../bridge/bridge-ipc.ts";
import { calculateSyncKey, type LiveSession } from "../../session/session.ts";
import type { RuntimeSessionStore, RuntimeSessionSync } from "../../session/session-state.ts";
import { DEFAULT_AGY_PLUGIN_DIR, buildCliProcessEnvironment } from "../../discovery/plugin-install.ts";
import { validateAgyVersion } from "../../runtime/version.ts";
import { debugLog } from "../../shared/debug.ts";
import { expandHome } from "../../shared/paths.ts";
import type { AgyBridgeConfig } from "../../shared/types.ts";

const errorStates = new WeakMap<LiveSession, ConversationErrorState>();

function errorStateFor(session: LiveSession, conversationId?: string): ConversationErrorState {
  let state = errorStates.get(session);
  if (!state || state.conversationId !== conversationId) {
    state = { conversationId };
    errorStates.set(session, state);
  }
  return state;
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

export async function prepareRuntime(
  model: Model<any>,
  context: Context,
  tools: readonly Tool[],
  options: Pick<SimpleStreamOptions, "signal" | "env"> | undefined,
  config: Pick<AgyBridgeConfig, "agyPath" | "agentName" | "pluginDir" | "agentDir"> | undefined,
  dependencies: {
    store: Pick<RuntimeSessionStore, "get" | "delete">;
    sync: Pick<RuntimeSessionSync, "decide" | "getSyncedMessageCount">;
    sessionVersion: string;
    installPlugin: (pluginDir: string) => Promise<void>;
  },
  liveSession: LiveSession,
  selection: ReturnType<typeof resolveModelAndEffort>,
  preparationId: symbol,
): Promise<{ proc: CliRuntimeSession; mcpServer: BridgeIPC; reconstructContext: boolean; modelId: string }> {
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
  const checkpoint = await dependencies.store.get(liveSession.piSessionId, options?.env?.AGY_BRIDGE_LOGIN_EPOCH, dependencies.sessionVersion);
  checkPreparation();
  const decision = dependencies.sync.decide(liveSession, {
    syncKey,
    ...(expectedConversationId ? { conversationId: expectedConversationId } : {}),
    messages: context.messages,
    ...(checkpoint ? { checkpoint } : {}),
  });

  debugLog("register", "Antigravity CLI runtime decision", {
    action: decision.action,
    messageCount: context.messages.length,
    syncedMessageCount: dependencies.sync.getSyncedMessageCount(liveSession),
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
    if (!(proc instanceof CliRuntimeSession)) throw new Error("CLI cannot reuse another driver's runtime");
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
  await validateAgyVersion(config?.agyPath);
  checkPreparation();

  const startRuntime = async (conversationId?: string) => {
    const mcpServer = new BridgeIPC(tools, liveSession.id, liveSession.resources);
    let proc: CliRuntimeSession | null = null;
    const abortStartup = () => {
      void mcpServer.close().catch((error) => debugLog("session", "Error closing cancelled MCP startup:", error));
      void proc?.abort().catch((error) => debugLog("session", "Error aborting cancelled Antigravity CLI startup:", error));
    };
    options?.signal?.addEventListener("abort", abortStartup, { once: true });
    try {
      checkPreparation();
      await mcpServer.start();
      checkPreparation();
      await dependencies.installPlugin(pluginDir);
      checkPreparation();
      const errorState = errorStateFor(liveSession, conversationId);
      proc = new CliRuntimeSession({
        agyPath: config?.agyPath,
        agentName,
        model: baseModel,
        conversationId,
        effort,
        environment: buildCliProcessEnvironment(mcpServer.bridgeUri),
      }, new Set(tools.map((tool) => tool.name)), errorState);
      const initEvent = await proc.start();
      checkPreparation();
      debugLog("register", "Antigravity CLI init conversation id:", initEvent.conversation_id);
      if (conversationId && initEvent.conversation_id !== conversationId) {
        throw new Error("Antigravity CLI did not restore the requested conversation");
      }
      if (!proc.isRunning) throw new Error("Antigravity CLI exited before input delivery");
      if (errorState.conversationId !== initEvent.conversation_id) errorState.lastError = undefined;
      errorState.conversationId = initEvent.conversation_id;
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
      await dependencies.store.delete(liveSession.piSessionId).catch((failure) => {
        debugLog("session", "Could not invalidate rejected conversation reference:", failure);
      });
      checkPreparation();
      liveSession.resources.disposeAll();
    }
  }

  return { ...await startRuntime(), reconstructContext: true };
}

