import type { ContentBlock, SessionNotification } from "@agentclientprotocol/sdk";
import type { Message } from "@earendil-works/pi-ai";
import type { DriverSession, DriverSubmission, RuntimeEvent } from "../types.ts";
import { AcpSession, type AcpSessionOptions } from "./session.ts";
import { AcpEventTranslator } from "./events.ts";
import { AcpMcpPermissions } from "./permissions.ts";
import { debugLog } from "../../shared/debug.ts";
import { fingerprintAcpSystemPrompt } from "./instructions.ts";
import { serializeMessage } from "../../session/history.ts";

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
  readonly instructionKey: string | undefined;
  private translator: AcpEventTranslator | undefined;
  private permissions: AcpMcpPermissions | undefined;
  private readonly allowedToolNames: ReadonlySet<string>;
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private submitting = false;
  readonly options: Omit<AcpSessionOptions, "onUpdate">;
  constructor(options: Omit<AcpSessionOptions, "onUpdate">, allowedToolNames: ReadonlySet<string> = new Set()) {
    this.options = options;
    this.instructionKey = options.systemPrompt === undefined ? undefined : fingerprintAcpSystemPrompt(options.systemPrompt);
    this.allowedToolNames = allowedToolNames;
    this.session = new AcpSession({ ...options,
      onPermission: (request) => this.permissions?.reply(request) ?? { outcome: { outcome: "cancelled" } },
      onClose: (error) => {
        this.permissions?.reset();
        this.emit({ type: "complete", reason: "error", error: error instanceof Error ? error.message : String(error), resumable: false });
      },
      onUpdate: (update: SessionNotification) => {
        this.permissions?.observe(update);
        this.translator?.translate(update, "live", this.emit);
      },
    });
  }
  get isRunning(): boolean { return this.session.isRunning; }
  async prepare(signal?: AbortSignal): Promise<void> {
    await this.session.prepare(signal);
    this.translator = new AcpEventTranslator(this.session.id);
    this.permissions = new AcpMcpPermissions(this.session.id, this.allowedToolNames);
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
    if (this.submitting || this.session.hasActivePrompt) throw new Error("ACP prompt already active");
    if (!this.isRunning) throw new Error("ACP session is not running");
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
      if (!payload || typeof payload !== "object" || !("sessionId" in payload) || payload.sessionId !== this.session.id || !("prompt" in payload) || !Array.isArray(payload.prompt) || !payload.prompt.length) throw new Error("Invalid ACP payload");
      const prompt: ContentBlock[] = payload.prompt.map((block: unknown) => {
        if (!block || typeof block !== "object" || !("type" in block)) throw new Error("Invalid ACP content block");
        if (block.type === "text" && "text" in block && typeof block.text === "string") return { type: "text", text: block.text };
        if (block.type === "image" && "data" in block && typeof block.data === "string" && "mimeType" in block && typeof block.mimeType === "string") return { type: "image", data: block.data, mimeType: block.mimeType };
        throw new Error("ACP payload supports text and image content blocks");
      });
      if (!input.beforeInput()) return;
      this.emit({ type: "start" });
      this.emit({ type: "session-reference", reference: this.session.id });
      // Do not await the native prompt: MCP can suspend it across Pi turns.
      void this.session.prompt(prompt).then((response) => {
        this.translator?.complete(response, this.emit);
      }, (error: unknown) => {
        this.emit({ type: "complete", reason: "error", error: String(error), resumable: false });
        void this.session.dispose().catch((cleanupError) => debugLog("session", "ACP runtime cleanup failed:", cleanupError));
      });
    } finally { this.submitting = false; }
  }
  abort(): Promise<void> {
    this.listeners.clear();
    this.permissions?.reset();
    return this.session.cancel();
  }
}
