import type { ContentBlock, SessionNotification } from "@agentclientprotocol/sdk";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { BridgeMessage, DriverSession, DriverSubmission, RuntimeEvent } from "../types.ts";
import { Session, type AcpSessionOptions } from "./session.ts";
import { EventProcessor } from "./events.ts";
import { McpPermissions } from "./permissions.ts";
import { debugLog } from "../../shared/debug.ts";
import { fingerprintAcpSystemPrompt } from "./instructions.ts";
import { extractImagesFromText, serializeContextUpdate } from "../../provider/context-prompt.ts";
import { expandHome } from "../../shared/paths.ts";
import { ArtifactReader } from "./artifact-reader.ts";
import { observeAcpImage } from "./image-observer.ts";

export function serializeAcpContent(messages: readonly BridgeMessage[]): ContentBlock[] {
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
          for (const extracted of extractImagesFromText(part.text)) {
            blocks.push(typeof extracted === "string" ? { type: "text", text: extracted } : extracted);
          }
        }
      } else if (part.type === "image") {
        blocks.push(part);
      }
    }
  }

  return blocks;
}

export class RuntimeSession implements DriverSession {
  readonly driver = "acp" as const;
  readonly session: Session;
  readonly compatibilityKey: string | undefined;
  private eventProcessor: EventProcessor | undefined;
  private permissions: McpPermissions | undefined;
  private readonly allowedToolNames: ReadonlySet<string>;
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private submitting = false;
  private completion: Promise<void> | undefined;
  private failure: Promise<void> | undefined;
  private userPrompt = "";
  private readonly reader: ArtifactReader;
  readonly options: Omit<AcpSessionOptions, "onUpdate" | "onRead">;
  constructor(
    options: Omit<AcpSessionOptions, "onUpdate" | "onRead">,
    allowedToolNames: ReadonlySet<string> = new Set(),
  ) {
    this.options = options;
    this.compatibilityKey = options.systemPrompt === undefined ? undefined : fingerprintAcpSystemPrompt(JSON.stringify([options.cwd, options.systemPrompt]));
    this.allowedToolNames = allowedToolNames;
    this.reader = new ArtifactReader({
      home: resolve(expandHome(process.env.GEMINI_HOME ?? `${homedir()}/.gemini`)),
      sessionId: () => this.session.id,
      allowedToolNames,
      observeImage: (image, signal) => observeAcpImage({
        executable: options.executable, cwd: options.cwd, model: options.model,
        ...(options.args !== undefined ? { args: options.args } : {}),
        ...(options.effort !== undefined ? { effort: "low" } : {}),
        image, userPrompt: this.userPrompt, signal,
      }),
    });
    this.session = new Session({ ...options,
      onRead: (request, signal) => this.reader.read(request, signal),
      onPermission: (request) => this.permissions?.reply(request) ?? { outcome: { outcome: "cancelled" } },
      onClose: (error) => {
        this.permissions?.reset();
        // An in-flight turn already owns completion, including read cleanup.
        if (!this.completion) {
          this.completion = this.fail(error);
        }
      },
      onUpdate: (update: SessionNotification) => {
        this.permissions?.observe(update);
        this.eventProcessor?.process(update, "live", this.emit);
      },
    });
  }
  get isRunning(): boolean { return this.session.isRunning; }
  async prepare(signal?: AbortSignal): Promise<void> {
    await this.session.prepare(signal);
    this.eventProcessor = new EventProcessor(this.session.id, this.allowedToolNames);
    this.permissions = new McpPermissions(this.session.id, this.allowedToolNames);
  }
  private fail(error: unknown): Promise<void> {
    // Claim failure ownership before cleanup can synchronously trigger onClose.
    this.failure ??= Promise.resolve().then(async () => {
      try {
        await this.reader.endPrompt();
      } catch (cleanupError) {
        debugLog("session", "ACP read cleanup failed:", cleanupError);
      }
      this.userPrompt = "";

      try {
        await this.session.dispose();
      } catch (cleanupError) {
        debugLog("session", "ACP runtime cleanup failed:", cleanupError);
        error = new Error(`${String(error)}; cleanup failed: ${String(cleanupError)}`);
      }
      this.completion = undefined;
      this.emit({ type: "complete", reason: "error", error: String(error), resumable: false });
    });
    return this.failure;
  }
  private emit = (event: RuntimeEvent): void => { for (const listener of this.listeners) listener(event); };
  onRuntimeEvent(handler: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(handler);
    return () => { this.listeners.delete(handler); };
  }
  serializeContextUpdate(messages: readonly Message[]): string {
    return serializeContextUpdate(messages.filter((message) => message.role !== "system"), "pending_tool_continuation");
  }
  async submit(input: DriverSubmission): Promise<void> {
    if (this.submitting || this.completion || this.session.hasActivePrompt) throw new Error("ACP prompt already active");
    if (!this.isRunning || this.failure) throw new Error("ACP session is not running");
    this.submitting = true;
    try {
      const content = serializeAcpContent(input.messages);
      if (content.length === 0) content.push({ type: "text", text: "Continue from the current conversation state without repeating completed work." });
      let payload: unknown = { sessionId: this.session.id, prompt: content };
      if (input.options?.onPayload) {
        try {
          payload = await input.options.onPayload(payload, input.model) ?? payload;
        } catch (error) {
          debugLog("provider", "onPayload hook threw:", error);
        }
      }
      if (this.completion || this.failure || !this.isRunning) throw new Error("ACP runtime closed before input delivery");
      if (!payload || typeof payload !== "object" || !("sessionId" in payload) || payload.sessionId !== this.session.id || !("prompt" in payload) || !Array.isArray(payload.prompt) || !payload.prompt.length) throw new Error("Invalid ACP payload");
      const prompt: ContentBlock[] = payload.prompt.map((block: unknown) => {
        if (!block || typeof block !== "object" || !("type" in block)) throw new Error("Invalid ACP content block");
        if (block.type === "text" && "text" in block && typeof block.text === "string") return { type: "text", text: block.text };
        if (block.type === "image" && "data" in block && typeof block.data === "string" && "mimeType" in block && typeof block.mimeType === "string") return { type: "image", data: block.data, mimeType: block.mimeType };
        throw new Error("ACP payload supports text and image content blocks");
      });
      if (!input.beforeInput()) return;
      const userMessage = [...input.messages].reverse().find((m) => m.role === "user");
      let userPrompt = "";
      if (userMessage) {
        if (typeof userMessage.content === "string") {
          userPrompt = userMessage.content;
        } else {
          userPrompt = userMessage.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
        }
      }
      this.userPrompt = userPrompt;
      this.reader.beginPrompt();
      this.emit({ type: "start" });
      this.emit({ type: "session-reference", reference: this.session.id });
      // Do not await the native prompt: MCP can suspend it across Pi turns.
      this.completion = this.session.prompt(prompt).then(async (response) => {
        await this.reader.endPrompt();
        this.userPrompt = "";
        this.completion = undefined;
        this.eventProcessor?.complete(response, this.emit);
      }).catch((error: unknown) => this.fail(error));
    } finally { this.submitting = false; }
  }
  async abort(): Promise<void> {
    const readsClosed = this.reader.endPrompt();
    this.listeners.clear();
    this.permissions?.reset();
    const results = await Promise.allSettled([readsClosed, this.session.cancel()]);
    await this.completion;
    this.userPrompt = "";

    const failures = results.filter(result => result.status === "rejected");
    if (failures.length === 1) throw failures[0]!.reason;
    if (failures.length > 1) throw new AggregateError(failures.map(result => result.reason), "ACP abort cleanup failed");
  }
}
