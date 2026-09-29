import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  Tool,
} from "@earendil-works/pi-ai";
import { PiEventAdapter } from "./events.ts";
import { AgyRuntime } from "./process.ts";
import { BridgeIPC } from "./bridge-ipc.ts";
import {
  LiveSessionRegistry,
  PiContextAdapter,
  calculateSyncKey,
  type LiveSession,
} from "./session.ts";
import { RuntimeSessionStore, RuntimeSessionSync } from "./session-state.ts";
import { DEFAULT_AGY_PLUGIN_DIR, ensureAgyPluginInstalled } from "./plugin-install.ts";
import { validateAgyVersion } from "./version.ts";
import { DEFAULT_AGY_MODELS } from "./models.ts";
import { debugLog } from "./debug.ts";
import type { AgyBridgeConfig } from "./types.ts";

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

export function formatContextPrompt(context: Context, isReused: boolean): string {
  const currentMessage = context.messages.at(-1);
  if (isReused) return currentMessage ? formatMessageText(currentMessage) : "";

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

  return formatXmlElement(tagName, `role="${message.role}"`, formatXmlContent(message));
}

function formatXmlContent(message: Message): string[] {
  const content = typeof message.content === "string"
    ? [`<text>${escapeXml(message.content)}</text>`]
    : message.content.flatMap((block) => {
        if (block.type === "text") return [`<text>${escapeXml(block.text)}</text>`];
        if (block.type === "image") {
          return [`<image mime_type="${escapeXml(block.mimeType)}">binary content omitted</image>`];
        }
        if (block.type === "toolCall") {
          const attributes = `id="${escapeXml(block.id)}" name="${escapeXml(block.name)}"`;
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
  options?: SimpleStreamOptions
): { baseModel: string; effort?: "low" | "medium" | "high" | undefined } {
  const requested =
    (options as any)?.reasoningEffort ??
    (options as any)?.reasoning ??
    (options as any)?.thinkingLevel;

  let effort: "low" | "medium" | "high" | undefined;
  if (requested === "low" || requested === "medium" || requested === "high") {
    effort = requested;
  }

  let baseModel = modelId;
  const match = modelId.match(/^(gemini-[^]+)-(low|medium|high)$/);
  if (match && match[1]) {
    baseModel = match[1];
    if (!effort && (match[2] === "low" || match[2] === "medium" || match[2] === "high")) {
      effort = match[2];
    }
  }

  if (!effort && baseModel.toLowerCase().includes("gemini")) {
    effort = "medium";
  }

  return { baseModel, effort };
}

export function expandHome(filepath: string): string {
  if (filepath.startsWith("~/") || filepath === "~") {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

export function streamAgyProvider(
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: AgyBridgeConfig | undefined,
  bridge: AgyBridge
): AssistantMessageEventStream {
  const contextTools = context.tools ?? [];
  const tools = contextTools.length > 0 ? contextTools : bridge.getRegisteredTools();
  debugLog("mcp", "Pi provider context keys:", Object.keys(context));
  debugLog("mcp", "Pi provider context tools:", contextTools.map((tool) => tool.name));
  debugLog("mcp", "Pi bridge tools:", tools.map((tool) => tool.name));
  const toolSyncValues = tools.map((tool) => JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
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

  const liveSession = bridge.liveSessions.getOrCreate(piSessionId!);

  (async () => {
    let unsubscribe: (() => void) | null = null;
    let turnCounted = false;
    let proc: AgyRuntime | null = null;
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
      const { baseModel, effort } = resolveModelAndEffort(model.id, options);
      const agentName = config?.agentName ?? "pi-bridge";
      const systemPrompt = context.systemPrompt ?? "";
      const syncKey = calculateSyncKey(systemPrompt, toolSyncValues, baseModel, effort ?? "", agentName);
      const turnIndex = context.messages.filter((message) => message.role === "assistant").length;
      const latestAssistant = [...context.messages].reverse().find((message) => message.role === "assistant");
      const expectedConversationId = latestAssistant?.role === "assistant"
        ? latestAssistant.responseId
        : undefined;
      const rawPluginDir = config?.pluginDir ?? config?.agentDir;
      const pluginDir = rawPluginDir
        ? path.resolve(expandHome(rawPluginDir))
        : DEFAULT_AGY_PLUGIN_DIR;
      const runtimeRef = await bridge.runtimeSessionStore.get(liveSession.piSessionId);
      const decision = bridge.runtimeSessionSync.decide(liveSession, {
        syncKey,
        turnIndex,
        ...(expectedConversationId ? { conversationId: expectedConversationId } : {}),
        canonicalHistory: context.messages,
        ...(runtimeRef ? { runtimeRef } : {}),
      });
      const canReuse = decision.action === "continue";
      const canResume = decision.action === "resume";

      debugLog("register", "AGY runtime decision", {
        action: decision.action,
        turnIndex,
        sessionTurnIndex: liveSession.turnIndex,
        processRunning: liveSession.activeProcess?.isRunning ?? false,
        sessionConversationId: liveSession.conversationId,
        expectedConversationId,
        hasActiveProcess: liveSession.activeProcess !== null,
      });

      if (canReuse && liveSession.activeProcess) {
        debugLog("register", `Reusing existing agy process for turn ${turnIndex}`);
        proc = liveSession.activeProcess;
        mcpServer = liveSession.activeMcpServer;
      } else {
        debugLog("register", `Starting fresh agy process (turn ${turnIndex}, canReuse: ${canReuse})`);
        await liveSession.dispose();

        await validateAgyVersion(config?.agyPath, config?.minVersion);

        mcpServer = new BridgeIPC(tools, liveSession.id, liveSession.resources);
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

        try {
          const initEvent = await proc.start();
          debugLog("register", "AGY init conversation id:", initEvent.conversation_id);
          await mcpServer.waitForConnection();
          liveSession.setSession(proc, syncKey, mcpServer, initEvent.conversation_id);
          liveSession.turnIndex = turnIndex;

          if (options?.onResponse) {
            try {
              options.onResponse(initEvent as any, model);
            } catch (err) {
              debugLog("register", "Error in options.onResponse:", err);
            }
          }
        } catch (error) {
          await mcpServer.close();
          throw error;
        }
      }

      if (!proc || !mcpServer) {
        throw new Error("Agy process or Pi MCP bridge was not initialized");
      }

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

      const deliveredToolResults = mcpServer.resolveToolResults(context.messages);
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

      let prompt = formatContextPrompt(context, canReuse || canResume);
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
  public readonly liveSessions = new LiveSessionRegistry();
  public readonly runtimeSessionSync = new RuntimeSessionSync();
  public readonly piContextAdapter = new PiContextAdapter();
  public readonly runtimeSessionStore = new RuntimeSessionStore(this.piContextAdapter);

  constructor(pi: ExtensionAPI, config?: AgyBridgeConfig) {
    this.pi = pi;
    this.config = config;
  }

  public async ensureAgyPluginInstalled(pluginDir: string): Promise<void> {
    await ensureAgyPluginInstalled(this.config?.agyPath, pluginDir);
  }

  public getRegisteredTools(): Tool[] {
    const activeTools = this.pi.getActiveTools();
    const tools = this.pi.getAllTools() as Tool[];
    debugLog("mcp", "Pi registered tools:", tools.map((tool) => tool.name));
    debugLog("mcp", "Pi active tool names:", activeTools);
    return tools;
  }

  public start(): void {
    this.pi.on("session_start", (_event, ctx) => {
      this.piContextAdapter.bind(ctx.sessionManager);
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
      models: this.config?.models ?? DEFAULT_AGY_MODELS,
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
