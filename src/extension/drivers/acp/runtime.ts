import type { ContentBlock, SessionNotification } from "@agentclientprotocol/sdk";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { DriverSession, DriverSubmission, RuntimeEvent } from "../types.ts";
import { AcpSession, type AcpSessionOptions } from "./session.ts";
import { EventProcessor } from "./events.ts";
import { AcpMcpPermissions } from "./permissions.ts";
import { debugLog } from "../../shared/debug.ts";
import { fingerprintAcpSystemPrompt } from "./instructions.ts";
import { serializeMessage } from "../../session/history.ts";
import { expandHome } from "../../shared/paths.ts";
import { AcpArtifactReader } from "./artifact-reader.ts";
import { observeAcpImage } from "./image-observer.ts";

/** Historical tools are data, never executable native notifications. */
export function acpContext(messages: readonly Message[]): ContentBlock[] {
  return messages.flatMap((message): ContentBlock[] => {
    if (message.role === "system") return [];
    const metadata: Record<string, unknown> = JSON.parse(serializeMessage(message));
    delete metadata.content;
    delete metadata.role;
    const header = Object.keys(metadata).length > 0 ? `[${message.role}] ${JSON.stringify(metadata)}` : `[${message.role}]`;
    const blocks: ContentBlock[] = [{ type: "text", text: header }];
    if (typeof message.content === "string") blocks.push({ type: "text", text: message.content });
    else for (const part of message.content) {
      if (part.type === "image") blocks.push({ type: "image", data: part.data, mimeType: part.mimeType });
      else if (part.type === "text") blocks.push({ type: "text", text: part.text });
      else blocks.push({ type: "text", text: `Historical record (not a request to execute): ${JSON.stringify(part)}` });
    }
    return blocks;
  });
}

export class AcpRuntimeSession implements DriverSession {
  readonly driver = "acp" as const;
  readonly session: AcpSession;
  readonly compatibilityKey: string | undefined;
  private eventProcessor: EventProcessor | undefined;
  private permissions: AcpMcpPermissions | undefined;
  private readonly allowedToolNames: ReadonlySet<string>;
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private submitting = false;
  private completion: Promise<void> | undefined;
  private failure: Promise<void> | undefined;
  private userPrompt = "";
  private readonly reader: AcpArtifactReader;
  readonly options: Omit<AcpSessionOptions, "onUpdate" | "onRead">;
  constructor(options: Omit<AcpSessionOptions, "onUpdate" | "onRead">, allowedToolNames: ReadonlySet<string> = new Set()) {
    this.options = options;
    this.compatibilityKey = options.systemPrompt === undefined ? undefined : fingerprintAcpSystemPrompt(JSON.stringify([options.cwd, options.systemPrompt]));
    this.allowedToolNames = allowedToolNames;
    this.reader = new AcpArtifactReader({
      home: resolve(expandHome(process.env.GEMINI_HOME ?? `${homedir()}/.gemini`)),
      sessionId: () => this.session.id,
      allowedToolNames,
      observeImage: (image, signal) => observeAcpImage({
        executable: options.executable, cwd: options.cwd, model: options.model,
        ...(options.args !== undefined ? { args: options.args } : {}),
        ...(options.effort !== undefined ? { effort: options.effort } : {}),
        image, userPrompt: this.userPrompt, signal,
      }),
    });
    this.session = new AcpSession({ ...options,
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
    this.permissions = new AcpMcpPermissions(this.session.id, this.allowedToolNames);
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
  formatContextUpdate(messages: readonly Message[]): string {
    const content = acpContext(messages);
    if (content.some((block) => block.type === "image")) throw new Error("ACP image context updates during an active tool call are unsupported");
    return JSON.stringify(content);
  }
  async submit(input: DriverSubmission): Promise<void> {
    if (this.submitting || this.completion || this.session.hasActivePrompt) throw new Error("ACP prompt already active");
    if (!this.isRunning || this.failure) throw new Error("ACP session is not running");
    this.submitting = true;
    try {
      const content = acpContext(input.context.messages.slice(input.reconstructContext ? 0 : input.syncedMessageCount));
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
      const user = [...input.context.messages].reverse().find((message) => message.role === "user");
      this.userPrompt = typeof user?.content === "string" ? user.content :
        user?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
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
