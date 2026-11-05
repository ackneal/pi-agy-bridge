import path from "node:path";
import type { Context, Model, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import { Connection } from "./connection.ts";
import { RuntimeSession } from "./runtime.ts";
import { composeSystemPrompt, fingerprintSystemPrompt } from "./instructions.ts";
import { BridgeIPC } from "../../bridge/ipc.ts";
import { calculateSyncKey, type LiveSession } from "../../session/session.ts";
import type { RuntimeSessionStore, RuntimeSessionSync } from "../../session/state.ts";
import { DEFAULT_AGY_PLUGIN_DIR, buildCliProcessEnvironment } from "../../discovery/plugin-install.ts";
import { validateAgyVersion } from "../../runtime/version.ts";
import { debugLog } from "../../shared/debug.ts";
import type { BridgeMessage } from "../types.ts";

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
    throw new Error(`Unsupported Antigravity reasoning effort: ${String(requested)}. Supported values: low, medium, high.`);
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
    throw new Error(`Unsupported Antigravity reasoning effort for ${modelId}: ${effort}.`);
  }

  return { baseModel, effort };
}

export async function prepareRuntime(
  model: Model<any>,
  context: Context,
  systemMessages: readonly BridgeMessage[],
  tools: readonly Tool[],
  options: Pick<SimpleStreamOptions, "signal" | "env"> | undefined,
  cwd: string,
  dependencies: {
    store: Pick<RuntimeSessionStore, "get" | "delete">;
    sync: Pick<RuntimeSessionSync, "decide">;
    sessionVersion: string;
    executable?: string | undefined;
    installPlugin: (pluginDir: string) => Promise<void>;
  },
  liveSession: LiveSession,
  selection: ReturnType<typeof resolveModelAndEffort>,
  preparationId: symbol,
  standalone = false,
): Promise<{ proc: RuntimeSession; mcpServer: BridgeIPC; reconstructContext: boolean; modelId: string }> {
  const checkPreparation = () => {
    options?.signal?.throwIfAborted();
    if (!liveSession.ownsPreparation(preparationId)) {
      throw new Error("Antigravity runtime preparation was superseded");
    }
  };
  checkPreparation();

  const { baseModel, effort } = selection;
  const agentName = standalone ? "pi-standalone" : "pi-bridge-acp";
  cwd = path.resolve(cwd);

  const systemPrompt = standalone
    ? systemMessages.filter((message) => message.role === "system").map((message) => message.content.trim()).filter(Boolean).join("\n\n") || undefined
    : composeSystemPrompt(systemMessages);
  const compatibilityKey = systemPrompt === undefined ? undefined : fingerprintSystemPrompt(JSON.stringify([cwd, systemPrompt]));

  const toolSyncValues = tools.map((tool) => JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  const syncKey = calculateSyncKey(context.systemPrompt ?? "", toolSyncValues, baseModel, effort ?? "", agentName);

  const latestAssistant = [...context.messages].reverse().find((message) => message.role === "assistant");
  const expectedConversationId = latestAssistant?.role === "assistant" ? latestAssistant.responseId : undefined;
  const pluginDir = DEFAULT_AGY_PLUGIN_DIR;
  const checkpoint = standalone ? undefined : await dependencies.store.get(liveSession.piSessionId, dependencies.sessionVersion);
  checkPreparation();

  const decision = standalone ? { action: "rebuild" as const } : dependencies.sync.decide(liveSession, {
    syncKey,
    ...(compatibilityKey !== undefined ? { compatibilityKey } : {}),
    ...(expectedConversationId ? { conversationId: expectedConversationId } : {}),
    messages: context.messages,
    ...(checkpoint ? { checkpoint } : {}),
  });

  debugLog("register", "Antigravity ACP runtime decision", {
    action: decision.action,
    messageCount: context.messages.length,
    processRunning: liveSession.activeProcess?.isRunning ?? false,
    sessionConversationId: liveSession.conversationId,
    expectedConversationId,
    hasActiveProcess: liveSession.activeProcess !== null,
  });

  if (decision.action === "continue" && liveSession.activeProcess) {
    debugLog("register", "Reusing existing Antigravity ACP process");
    if (!liveSession.activeMcpServer) {
      throw new Error("Antigravity ACP process or Pi MCP bridge was not initialized");
    }
    const proc = liveSession.activeProcess;
    if (!(proc instanceof RuntimeSession)) throw new Error("AgyAcp cannot reuse another driver's runtime");

    const modelMatches = proc.options.model === baseModel && proc.options.effort === effort;
    return {
      proc,
      mcpServer: liveSession.activeMcpServer,
      reconstructContext: false,
      modelId: modelMatches ? model.id : latestAssistant?.model ?? proc.options.model,
    };
  }

  debugLog("register", "Starting a replacement Antigravity ACP process");
  await liveSession.dispose({
    preserveConversation: decision.action === "resume",
    preserveResources: decision.action === "resume" && decision.conversationId === liveSession.conversationId,
    preparationId,
  });
  checkPreparation();

  await validateAgyVersion(dependencies.executable);
  checkPreparation();

  const startRuntime = async (conversationId?: string) => {
    const mcpServer = new BridgeIPC(tools, liveSession.id, liveSession.resources);
    let connection: Connection | null = null;

    const abortStartup = () => {
      void mcpServer.close().catch((err) => debugLog("session", "Error closing cancelled MCP startup:", err));
      void connection?.dispose().catch((err) => debugLog("session", "Error aborting cancelled connection:", err));
    };
    options?.signal?.addEventListener("abort", abortStartup, { once: true });

    try {
      checkPreparation();
      if (!standalone) {
        await mcpServer.start();
        checkPreparation();
      }

      await dependencies.installPlugin(pluginDir);
      checkPreparation();

      const executable = dependencies.executable ?? "agy";
      const args = [
        "acp",
        "--stdio",
        "--process-per-session",
        "--agent",
        agentName,
      ];
      const environment = standalone ? {} : buildCliProcessEnvironment(mcpServer.bridgeUri);

      connection = new Connection({
        executable,
        args,
        cwd,
        environment,
      });

      const proc = new RuntimeSession(
        connection,
        {
          cwd,
          model: baseModel,
          effort,
          sessionId: conversationId,
          systemPrompt,
          standalone,
        },
        new Set(tools.map((tool) => tool.name)),
        compatibilityKey,
      );

      await proc.prepare(options?.signal);
      checkPreparation();

      if (!proc.isRunning) throw new Error("Antigravity ACP exited before input delivery");

      if (!liveSession.setSession(proc, syncKey, mcpServer, proc.id, preparationId)) {
        throw new Error("Antigravity ACP runtime preparation was superseded");
      }

      return { proc, mcpServer, modelId: model.id };
    } catch (error) {
      await mcpServer.close().catch((err) => debugLog("session", "Error closing unowned MCP bridge:", err));
      if (connection) {
        await connection.dispose().catch((err) => debugLog("session", "Error aborting unowned connection:", err));
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
