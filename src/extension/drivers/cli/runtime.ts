import type { Message, TextContent } from "@earendil-works/pi-ai";
import { AgyRuntime } from "../../runtime/process.ts";
import { serializeContextUpdate } from "../../provider/context-prompt.ts";
import { debugArtifact, debugLog } from "../../shared/debug.ts";
import { EventTranslator, type ConversationErrorState } from "./events.ts";
import type { BridgeMessage, DriverSession, DriverSubmission, RuntimeEvent } from "../types.ts";

export function serializePrompt(messages: readonly BridgeMessage[]): string {
  const parts: string[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const content = message.content.trim();
      if (content) {
        parts.push(`[System]: ${content}`);
      }
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

/** CLI protocol and prompt policy stay outside the shared turn coordinator. */
export class RuntimeSession extends AgyRuntime implements DriverSession {
  readonly compatibilityKey: string | undefined;
  readonly driver = "cli" as const;
  private readonly allowedToolNames: ReadonlySet<string>;
  private readonly errorState: ConversationErrorState;

  constructor(
    options: ConstructorParameters<typeof AgyRuntime>[0],
    allowedToolNames: ReadonlySet<string>,
    errorState: ConversationErrorState,
    compatibilityKey?: string,
  ) {
    super(options);
    this.compatibilityKey = compatibilityKey;
    this.allowedToolNames = allowedToolNames;
    this.errorState = errorState;
  }

  onRuntimeEvent(handler: (event: RuntimeEvent) => void): () => void {
    const translator = new EventTranslator({
      allowedToolNames: this.allowedToolNames, errorState: this.errorState,
    });
    return this.onEvent((event, source) => translator.translate(event, source, handler));
  }

  serializeContextUpdate(messages: readonly Message[]): string {
    return serializeContextUpdate(messages, "pending_tool_continuation");
  }

  async submit(input: DriverSubmission): Promise<void> {
    let prompt = serializePrompt(input.messages);
    if (!prompt.trim()) prompt = "Continue from the current conversation state without repeating completed work.";

    if (input.options?.onPayload) {
      try {
        const rewritten = await input.options.onPayload({ prompt }, input.model);
        if (rewritten && typeof rewritten === "object" && "prompt" in rewritten) prompt = (rewritten as { prompt: string }).prompt;
      } catch (error) {
        debugLog("register", "Error in options.onPayload:", error);
      }
    }
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Antigravity CLI prompt must be a non-empty string");

    debugArtifact("agy-payload", {
      sessionId: input.options?.sessionId, conversationId: this.errorState.conversationId,
      messagesCount: input.messages.length, prompt,
    });
    if (!input.beforeInput()) return;
    await this.send({ event: "user", message: { content: prompt } });
  }
}
