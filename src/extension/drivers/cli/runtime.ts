import type { ContentBlock, SessionConfigOption, SessionNotification } from "@agentclientprotocol/sdk";
import * as acp from "@agentclientprotocol/sdk";
import type { Message, TextContent } from "@earendil-works/pi-ai";
import type { BridgeMessage, DriverSession, DriverSubmission, RuntimeEvent } from "../types.ts";
import type { Connection } from "./connection.ts";
import { EventProcessor } from "./events.ts";
import { debugArtifact, debugLog } from "../../shared/debug.ts";
import { serializeContextUpdate } from "../../provider/context-prompt.ts";

type SessionRequests = {
  "session/new": [acp.NewSessionRequest, acp.NewSessionResponse];
  "session/load": [acp.LoadSessionRequest, acp.LoadSessionResponse];
  "session/set_config_option": [acp.SetSessionConfigOptionRequest, acp.SetSessionConfigOptionResponse];
  "session/setConfigOption": [acp.SetSessionConfigOptionRequest, acp.SetSessionConfigOptionResponse];
  "session/prompt": [acp.PromptRequest, acp.PromptResponse];
};

export interface RuntimeConnection extends Pick<Connection, "start" | "isRunning" | "notify" | "dispose"> {
  request<M extends keyof SessionRequests>(method: M, params: SessionRequests[M][0]): Promise<SessionRequests[M][1]>;
  onSessionUpdate(handler: (notification: SessionNotification) => void | Promise<void>): () => void;
}

export interface AcpSessionClientOptions {
  connection: RuntimeConnection;
  cwd: string;
  model: string;
  effort?: "low" | "medium" | "high" | undefined;
  sessionId?: string | undefined;
  systemPrompt?: string | undefined;
  standalone?: boolean | undefined;
  onUpdate: (notification: SessionNotification) => void | Promise<void>;
}

export class AcpSessionClient {
  private readonly connection: RuntimeConnection;
  private readonly options: AcpSessionClientOptions;
  private sessionId: string | undefined;
  private configOptions: SessionConfigOption[] = [];
  private activePrompt: Promise<acp.PromptResponse> | undefined;
  private preparing = true;
  private preparation: Promise<void> | undefined;
  private readonly unsubscribe: () => void;

  constructor(options: AcpSessionClientOptions) {
    this.connection = options.connection;
    this.options = options;
    this.unsubscribe = this.connection.onSessionUpdate((notification) => {
      // Loading replays history before the response; it is not live output.
      if (!this.preparing && notification.sessionId === this.sessionId) {
        return options.onUpdate(notification);
      }
    });
  }

  get id(): string {
    if (!this.sessionId) throw new Error("ACP session is not prepared");
    return this.sessionId;
  }

  get isRunning(): boolean {
    return !this.preparing && this.connection.isRunning;
  }

  get hasActivePrompt(): boolean {
    return this.activePrompt !== undefined;
  }

  prepare(signal?: AbortSignal): Promise<void> {
    this.preparation ??= this.prepareSession(signal);
    return this.preparation;
  }

  private async prepareSession(signal?: AbortSignal): Promise<void> {
    const abort = () => { void this.dispose().catch((error: unknown) => debugLog("session", "ACP preparation cleanup failed:", error)); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      await this.initializeSession(signal);
    } catch (error) {
      try {
        await this.dispose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "ACP preparation and cleanup failed");
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private async initializeSession(signal?: AbortSignal): Promise<void> {
    const initialized = await this.connection.start(signal);
    signal?.throwIfAborted();

    const antigravityMeta: Record<string, unknown> = {
      enabledTools: this.options.standalone ? [] : ["view_file"],
      ...(this.options.systemPrompt !== undefined ? { systemPrompt: { append: this.options.systemPrompt } } : {}),
    };

    const params: acp.NewSessionRequest = {
      cwd: this.options.cwd,
      mcpServers: [],
      _meta: { antigravity: antigravityMeta },
    };

    if (this.options.sessionId) {
      if (!initialized.agentCapabilities?.loadSession) {
        throw new Error("ACP server does not support session loading");
      }
      const loaded = await this.connection.request(acp.methods.agent.session.load, { ...params, sessionId: this.options.sessionId });
      this.sessionId = this.options.sessionId;
      this.configOptions = loaded.configOptions ?? [];
    } else {
      const created = await this.connection.request(acp.methods.agent.session.new, params);
      if (!created.sessionId?.trim()) throw new Error("ACP server returned an empty session ID");
      this.sessionId = created.sessionId;
      this.configOptions = created.configOptions ?? [];
    }
    signal?.throwIfAborted();

    await this.applyConfiguration("model", this.options.model);
    signal?.throwIfAborted();

    const effortKey = this.configOptions.some((opt) => opt.id === "thought_level") ? "thought_level" : "thinking_level";
    if (this.options.effort !== undefined) {
      await this.applyConfiguration(effortKey, this.options.effort);
    }
    signal?.throwIfAborted();

    this.verifyConfiguration("model", this.options.model);
    if (this.options.effort !== undefined) this.verifyConfiguration(effortKey, this.options.effort);

    this.preparing = false;
  }

  private async applyConfiguration(id: string, value: string): Promise<void> {
    const option = this.configOptions.find((entry) => entry.id === id);
    if (!option || option.type !== "select") throw new Error(`ACP required configuration is unavailable: ${id}`);

    const values = option.options.flatMap((entry) => "group" in entry ? entry.options : [entry]);
    if (!values.some((entry) => entry.value === value)) {
      throw new Error(`ACP unsupported ${id}: ${value}`);
    }

    try {
      const response = await this.connection.request(acp.methods.agent.session.setConfigOption, {
        sessionId: this.id,
        configId: id,
        value,
      });
      this.configOptions = response.configOptions;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("-32601") || msg.includes("Method not found")) {
        const response = await this.connection.request("session/setConfigOption", {
          sessionId: this.id,
          configId: id,
          value,
        });
        this.configOptions = response.configOptions;
      } else {
        throw error;
      }
    }
    this.verifyConfiguration(id, value);
  }

  private verifyConfiguration(id: string, value: string): void {
    if (this.configOptions.find((entry) => entry.id === id)?.currentValue !== value) {
      throw new Error(`ACP did not apply the requested ${id}: ${value}`);
    }
  }

  prompt(content: ContentBlock[]): Promise<acp.PromptResponse> {
    if (!this.isRunning) return Promise.reject(new Error("ACP session is not running"));
    if (this.activePrompt) return Promise.reject(new Error("ACP session already has an active prompt"));
    if (content.length === 0) return Promise.reject(new Error("ACP prompt must not be empty"));

    const request = this.connection.request(acp.methods.agent.session.prompt, { sessionId: this.id, prompt: content });
    const pending = request.finally(() => {
      if (this.activePrompt === pending) this.activePrompt = undefined;
    });
    this.activePrompt = pending;
    return pending;
  }

  async cancel(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.connection.isRunning && this.sessionId) {
        await Promise.race([
          this.connection.notify("session/cancel", { sessionId: this.sessionId }),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, 200); }),
        ]);
      }
    } finally {
      clearTimeout(timer);
      await this.dispose();
    }
  }

  dispose(): Promise<void> {
    this.unsubscribe();
    return this.connection.dispose();
  }
}

export function serializeContent(messages: readonly BridgeMessage[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;

    if (typeof message.content === "string") {
      if (message.content) {
        blocks.push({ type: "text", text: message.content });
      }
      continue;
    }

    for (const part of message.content) {
      if (part.type === "text") {
        if (part.text) {
          blocks.push({ type: "text", text: part.text });
        }
      } else if (part.type === "image") {
        blocks.push(part);
      }
    }
  }

  return blocks;
}

export function serializePrompt(messages: readonly BridgeMessage[]): string {
  const parts: string[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const content = message.content.trim();
      if (content) parts.push(`[System]: ${content}`);
      continue;
    }

    if (typeof message.content === "string") {
      if (message.content) parts.push(message.content);
      continue;
    }

    const textParts = message.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text);
    const text = textParts.filter(Boolean).join("\n\n");
    if (text) parts.push(text);
  }

  return parts.join("\n\n");
}

export class RuntimeSession implements DriverSession {
  readonly driver = "cli" as const;
  readonly sessionClient: AcpSessionClient;
  readonly compatibilityKey: string | undefined;
  private eventProcessor: EventProcessor | undefined;
  private readonly allowedToolNames: ReadonlySet<string>;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private submitting = false;
  private completion: Promise<void> | undefined;
  private failure: Promise<void> | undefined;

  constructor(
    connection: RuntimeConnection,
    readonly options: Omit<AcpSessionClientOptions, "connection" | "onUpdate">,
    allowedToolNames: ReadonlySet<string> = new Set(),
    compatibilityKey?: string,
  ) {
    this.compatibilityKey = compatibilityKey;
    this.allowedToolNames = allowedToolNames;

    this.sessionClient = new AcpSessionClient({
      ...options,
      connection,
      onUpdate: (update: SessionNotification) => {
        this.eventProcessor?.process(update, "live", this.emit);
      },
    });
  }

  get isRunning(): boolean {
    return this.sessionClient.isRunning;
  }

  get id(): string {
    return this.sessionClient.id;
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    await this.sessionClient.prepare(signal);
    this.eventProcessor = new EventProcessor(this.sessionClient.id, this.allowedToolNames);
  }

  private emit = (event: RuntimeEvent): void => {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        debugLog("session", "Error in runtime event listener:", error);
      }
    }
  };

  onRuntimeEvent(handler: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  serializeContextUpdate(messages: readonly Message[]): string {
    return serializeContextUpdate(messages.filter((m) => m.role !== "system"), "pending_tool_continuation");
  }

  async submit(input: DriverSubmission): Promise<void> {
    if (this.submitting || this.completion || this.sessionClient.hasActivePrompt) {
      throw new Error("ACP prompt already active");
    }
    if (!this.isRunning || this.failure) {
      throw new Error("ACP session is not running");
    }

    this.submitting = true;
    try {
      const content = serializeContent(input.messages);
      if (content.length === 0) {
        content.push({ type: "text", text: "Continue from the current conversation state without repeating completed work." });
      }

      let payload: unknown = { sessionId: this.sessionClient.id, prompt: content };
      if (input.options?.onPayload) {
        try {
          payload = await input.options.onPayload(payload, input.model) ?? payload;
        } catch (error) {
          debugLog("provider", "onPayload hook threw:", error);
        }
      }

      if (this.completion || this.failure || !this.isRunning) {
        throw new Error("ACP runtime closed before input delivery");
      }
      if (!payload || typeof payload !== "object" || !("sessionId" in payload) || payload.sessionId !== this.sessionClient.id || !("prompt" in payload) || !Array.isArray(payload.prompt) || !payload.prompt.length) {
        throw new Error("Invalid ACP payload");
      }

      const prompt: ContentBlock[] = payload.prompt.map((block: unknown) => {
        if (!block || typeof block !== "object" || !("type" in block)) throw new Error("Invalid ACP content block");
        if (block.type === "text" && "text" in block && typeof block.text === "string") return { type: "text", text: block.text };
        if (block.type === "image" && "data" in block && typeof block.data === "string" && "mimeType" in block && typeof block.mimeType === "string") {
          return { type: "image", data: block.data, mimeType: block.mimeType };
        }
        throw new Error("ACP payload supports text and image content blocks");
      });

      debugArtifact("cli-payload", {
        sessionId: input.options?.sessionId,
        conversationId: this.sessionClient.id,
        messagesCount: input.messages.length,
        promptBlocks: prompt.length,
      });

      if (!input.beforeInput()) return;

      this.emit({ type: "start" });
      this.emit({ type: "session-reference", reference: this.sessionClient.id });

      this.completion = this.sessionClient.prompt(prompt).then((response) => {
        this.completion = undefined;
        this.eventProcessor?.complete(response, this.emit);
      }).catch((error: unknown) => this.fail(error));
    } finally {
      this.submitting = false;
    }
  }

  private fail(error: unknown): Promise<void> {
    this.failure ??= Promise.resolve().then(async () => {
      try {
        await this.sessionClient.dispose();
      } catch (cleanupError) {
        debugLog("session", "ACP runtime cleanup failed:", cleanupError);
      }
      this.completion = undefined;
      this.emit({ type: "complete", reason: "error", error: String(error), resumable: false });
    });
    return this.failure;
  }

  async abort(): Promise<void> {
    this.listeners.clear();
    await this.sessionClient.cancel();
    await this.completion;
  }
}
