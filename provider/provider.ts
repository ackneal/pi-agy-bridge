import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  Tool,
} from "@earendil-works/pi-ai";
import { getCurrentTools, normalizeContext } from "@earendil-works/pi-ai";
import { PiEventAdapter } from "../runtime/events.ts";
import { AgyRuntime } from "../runtime/process.ts";
import { BridgeIPC } from "../bridge/bridge-ipc.ts";
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

export function formatMessageText(message: Message): string {
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
    return `<pi_context purpose="incremental_conversation">\n${messages.map((item) => indent(formatXmlMessage(item))).join("\n")}\n</pi_context>`;
  }

  const history = context.messages.slice(0, -1).map((message) => formatXmlMessage(message));
  const sections = [
    context.systemPrompt
      ? `<system_instructions>${escapeXml(context.systemPrompt)}</system_instructions>`
      : "",
    history.length > 0
      ? `<history>\n${history.map((message) => indent(message)).join("\n")}\n</history>`
      : "<history />",
    currentMessage ? formatXmlMessage(currentMessage, "current_message") : "",
  ].filter(Boolean);

  return `<pi_context purpose="reconstructed_conversation">\n${sections.map((section) => indent(section)).join("\n")}\n</pi_context>`;
}

function formatXmlMessage(message: Message, tagName: "message" | "current_message" = "message"): string {
  if (message.role === "toolResult") {
    const attributes = [
      ...(tagName === "current_message" ? ['role="toolResult"'] : []),
      `call_id="${escapeXml(message.toolCallId)}"`,
      `tool_name="${escapeXml(message.toolName)}"`,
      `is_error="${message.isError}"`,
    ].join(" ");
    return formatXmlElement(tagName === "current_message" ? tagName : "tool_result", attributes, formatXmlContent(message));
  }

  const attributes = [`role="${message.role}"`];
  if (message.role === "assistant") {
    attributes.push(`stop_reason="${escapeXml(message.stopReason)}"`);
    if (message.errorMessage !== undefined) attributes.push(`error_message="${escapeXml(message.errorMessage)}"`);
  }
  return formatXmlElement(tagName, attributes.join(" "), formatXmlContent(message));
}

function formatXmlContent(message: Message): string[] {
  const content = typeof message.content === "string"
    ? [`<text>${escapeXml(message.content)}</text>`]
    : message.content.flatMap((block) => {
        if (block.type === "text") return [`<text>${escapeXml(block.text)}</text>`];
        if (block.type === "image") {
          return [`<image mime_type="${escapeXml(block.mimeType)}" encoding="base64">${escapeXml(block.data)}</image>`];
        }
        if (block.type === "toolCall") {
          const attributes = `id="${escapeXml(block.id)}" name="${escapeXml(block.name)}"` +
            (block.namespace !== undefined ? ` namespace="${escapeXml(block.namespace)}"` : "");
          const args = `<arguments>${escapeXml(JSON.stringify(block.arguments))}</arguments>`;
          return [formatXmlElement("tool_call", attributes, [args])];
        }
        return [];
      });

  if (message.role === "system" && message.sections) {
    for (const [name, value] of Object.entries(message.sections)) {
      if (value !== null) {
        content.push(`<section name="${escapeXml(name)}">${escapeXml(value)}</section>`);
      }
    }
  }

  return content;
}

function formatXmlElement(tagName: string, attributes: string, content: string[]): string {
  const openingTag = attributes ? `<${tagName} ${attributes}>` : `<${tagName}>`;
  if (content.length === 0) return `${openingTag}</${tagName}>`;
  return `${openingTag}\n${content.map((item) => indent(item)).join("\n")}\n</${tagName}>`;
}

function indent(value: string): string {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
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
    throw new Error(`Unsupported AGY reasoning effort: ${String(requested)}. Supported values: low, medium, high.`);
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
    throw new Error(`Unsupported AGY reasoning effort for ${modelId}: ${effort}.`);
  }

  return { baseModel, effort };
}

export function expandHome(filepath: string): string {
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
  liveSession: LiveSession
): Promise<{ proc: AgyRuntime; mcpServer: BridgeIPC; reconstructContext: boolean }> {
  const { baseModel, effort } = resolveModelAndEffort(model.id, options, model.thinkingLevelMap);
  const agentName = config?.agentName ?? "pi-bridge";
  const toolSyncValues = tools.map((tool) => JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  const syncKey = calculateSyncKey(context.systemPrompt ?? "", toolSyncValues, baseModel, effort ?? "", agentName);
  const turnIndex = context.messages.filter((message) => message.role === "assistant").length;
  const latestAssistant = [...context.messages].reverse().find((message) => message.role === "assistant");
  const expectedConversationId = latestAssistant?.role === "assistant" ? latestAssistant.responseId : undefined;
  const rawPluginDir = config?.pluginDir ?? config?.agentDir;
  const pluginDir = rawPluginDir ? path.resolve(expandHome(rawPluginDir)) : DEFAULT_AGY_PLUGIN_DIR;
  const runtimeRef = await bridge.runtimeSessionStore.get(liveSession.piSessionId);
  const decision = bridge.runtimeSessionSync.decide(liveSession, {
    syncKey,
    turnIndex,
    ...(expectedConversationId ? { conversationId: expectedConversationId } : {}),
    canonicalHistory: context.messages,
    ...(runtimeRef ? { runtimeRef } : {}),
  });

  debugLog("register", "AGY runtime decision", {
    action: decision.action,
    turnIndex,
    sessionTurnIndex: liveSession.turnIndex,
    processRunning: liveSession.activeProcess?.isRunning ?? false,
    sessionConversationId: liveSession.conversationId,
    expectedConversationId,
    hasActiveProcess: liveSession.activeProcess !== null,
  });

  if (decision.action === "continue" && liveSession.activeProcess) {
    debugLog("register", `Reusing existing agy process for turn ${turnIndex}`);
    if (!liveSession.activeMcpServer) {
      throw new Error("Agy process or Pi MCP bridge was not initialized");
    }
    return { proc: liveSession.activeProcess, mcpServer: liveSession.activeMcpServer, reconstructContext: false };
  }

  debugLog("register", `Starting fresh agy process (turn ${turnIndex}, canReuse: ${decision.action === "continue"})`);
  debugLog("session", "Replacing AGY runtime", {
    action: decision.action,
    conversationId: liveSession.conversationId,
    hasPendingCalls: liveSession.activeMcpServer?.hasPendingCalls ?? false,
  });
  await liveSession.dispose();
  await validateAgyVersion(config?.agyPath, config?.minVersion);

  const mcpServer = new BridgeIPC(tools, liveSession.id, liveSession.resources);
  let proc: AgyRuntime | null = null;
  try {
    await mcpServer.start();
    await bridge.ensureAgyPluginInstalled(pluginDir);
    proc = new AgyRuntime({
      agyPath: config?.agyPath,
      agentName,
      model: baseModel,
      conversationId: decision.action === "resume" ? decision.conversationId : undefined,
      effort,
      environment: mcpServer.processEnvironment,
    });
    const initEvent = await proc.start();
    debugLog("register", "AGY init conversation id:", initEvent.conversation_id);
    await mcpServer.waitForConnection();
    liveSession.setSession(proc, syncKey, mcpServer, initEvent.conversation_id);
    liveSession.turnIndex = turnIndex;
    return { proc, mcpServer, reconstructContext: decision.action === "rebuild" };
  } catch (error) {
    // Ownership transfers to liveSession only after startup succeeds.
    await mcpServer.close().catch((cleanupError) => {
      debugLog("session", "Error closing unowned MCP bridge:", cleanupError);
    });
    if (proc) {
      await proc.abort().catch((cleanupError) => {
        debugLog("session", "Error aborting unowned AGY process:", cleanupError);
      });
    }
    throw error;
  }
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
    onBlockedTool: () => {
      queueMicrotask(() => void liveSession.dispose());
    },
  });
  const stream = adapter.stream;

  if (options?.signal?.aborted) {
    adapter.handleTermination("aborted", "Request was aborted before execution started");
    return stream;
  }

  const piSessionId = options?.sessionId;
  if (!piSessionId) {
    adapter.handleTermination("error", "Pi did not provide a sessionId for the AGY runtime");
    return stream;
  }

  const liveSession = bridge.liveSessions.getOrCreate(piSessionId);

  (async () => {
    let unsubscribe: (() => void) | null = null;
    let turnCounted = false;
    let mcpServer: BridgeIPC | null = null;

    const cleanup = () => {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };

    const completeTurn = () => {
      if (!adapter.isCompleted() || turnCounted) return;

      turnCounted = true;
      debugArtifact("assistant-message", { sessionId: liveSession.piSessionId, message: adapter.message });
      const responseId = adapter.message.responseId;
      if (!liveSession.conversationId && typeof responseId === "string" && responseId.length > 0) {
        liveSession.conversationId = responseId;
      }
      bridge.runtimeSessionSync.record(liveSession, context.messages, adapter.message);
      liveSession.incrementTurn();
      if (liveSession.conversationId) {
        void bridge.runtimeSessionStore.set(liveSession.piSessionId, {
          conversationId: liveSession.conversationId,
        }, [...context.messages, adapter.message]).catch((error) => {
          debugLog("session", "Could not persist AGY runtime reference:", error);
        });
      }
      mcpServer?.setToolCallHandler(null);
      cleanup();

      if (!mcpServer?.hasPendingCalls) {
        liveSession.clearAbortSignal();
      }
    };

    try {
      const runtime = await prepareRuntime(model, context, tools, options, config, bridge, liveSession);
      const proc = runtime.proc;
      mcpServer = runtime.mcpServer;

      unsubscribe = proc.onEvent((event) => {
        adapter.handleEvent(event);
        completeTurn();
      });

      liveSession.setAbortSignal(options?.signal, () => {
        cleanup();
        adapter.handleTermination("aborted", "Request aborted by user");
        void liveSession.dispose();
      });

      mcpServer.setToolCallHandler((batch) => {
        adapter.handleBridgeToolCalls(batch.calls);
        completeTurn();
        batch.complete();
      });

      const syncedMessageCount = runtime.reconstructContext ? 0 :
        bridge.runtimeSessionSync.getSyncedMessageCount(liveSession) ?? Math.max(0, context.messages.length - 1);
      const newMessages = context.messages.slice(syncedMessageCount);
      // MCP resumes the existing tool turn; a user event here could race that turn.
      if (mcpServer.hasPendingCalls && newMessages.some((message) => message.role !== "toolResult")) {
        throw new Error("Cannot safely deliver additional Pi messages while AGY tool results are pending; no updates were marked synchronized");
      }

      const deliveredToolResults = mcpServer.resolveToolResults(newMessages);
      if (deliveredToolResults > 0 && deliveredToolResults !== newMessages.length) {
        throw new Error("Some appended Pi tool results were not delivered to AGY; history was not marked synchronized");
      }
      if (deliveredToolResults > 0) {
        bridge.runtimeSessionSync.record(liveSession, context.messages);
        if (liveSession.conversationId) {
          await bridge.runtimeSessionStore.set(liveSession.piSessionId, {
            conversationId: liveSession.conversationId,
          }, context.messages);
        }
        return;
      }

      if (mcpServer.hasPendingCalls) {
        throw new Error("Agy is waiting for Pi tool results, but no matching result was returned");
      }

      let prompt = formatContextPrompt(context, !runtime.reconstructContext, syncedMessageCount);
      if (options?.onPayload) {
        try {
          const payload = { prompt };
          const rewritten = options.onPayload(payload, model);
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
      await proc.send({ event: "user", message: { content: prompt } });
    } catch (err) {
      cleanup();
      const errorMsg = err instanceof Error ? err.message : String(err);
      debugLog("register", "Turn execution failed:", errorMsg);
      adapter.handleTermination("error", errorMsg);
      await liveSession.dispose();
    }
  })();

  return stream;
}

export class AgyBridge {
  private readonly pi: ExtensionAPI;
  private readonly config: AgyBridgeConfig | undefined;
  private pluginError: DoctorFailure | undefined;
  private discoveryError: DoctorFailure | undefined;
  public readonly liveSessions = new LiveSessionRegistry();
  public readonly runtimeSessionSync = new RuntimeSessionSync();
  public readonly piContextAdapter = new PiContextAdapter();
  public readonly runtimeSessionStore = new RuntimeSessionStore(this.piContextAdapter);

  constructor(pi: ExtensionAPI, config?: AgyBridgeConfig) {
    this.pi = pi;
    this.config = config;
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
    let models: ProviderModelConfig[] = this.config?.models ?? [];

    this.pi.registerCommand("agy-bridge:doctor", {
      description: "Check AGY CLI, plugin installation, models, and MCP",
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
        });
        this.pi.sendMessage({
          customType: "pi-agy-bridge:doctor",
          content: report,
          display: true,
        }, { triggerTurn: false });
      },
    });

    this.pi.on("session_start", async (_event, ctx) => {
      this.piContextAdapter.bind(ctx.sessionManager);
      if (!this.config?.models) {
        await ctx.modelRegistry.refresh({ providers: ["agy"], allowNetwork: true });
      }
    });
    this.pi.on("session_shutdown", async () => {
      await this.liveSessions.disposeAll();
      this.piContextAdapter.clear();
    });

    this.pi.registerProvider("agy", {
      name: "agy",
      baseUrl: "agy",
      apiKey: "not-used",
      api: "agy" as any,
      models,
      ...(this.config?.models ? {} : {
        refreshModels: async (context) => {
          if (context.signal.aborted) return models;

          if (context.stored) {
            const restored = restoreStoredAgyModels(context.stored.models);
            const accepted = await context.publish({ update: () => { models = restored; } });
            if (!accepted) return models;
          }
          if (!context.allowNetwork) return models;

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
          return models;
        },
      }),
      streamSimple: (model, context, options) =>
        streamAgyProvider(model, context, options, this.config, this),
    });
  }
}

export function registerAgyProvider(
  pi: ExtensionAPI,
  config?: AgyBridgeConfig
): void {
  new AgyBridge(pi, config).start();
}
