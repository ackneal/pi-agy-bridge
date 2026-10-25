import type { Message } from "@earendil-works/pi-ai";
import { AgyRuntime } from "../../runtime/process.ts";
import { formatContextPrompt, formatContextUpdate } from "../../provider/context-prompt.ts";
import { debugArtifact, debugLog } from "../../shared/debug.ts";
import { CliEventTranslator, type ConversationErrorState } from "./events.ts";
import type { DriverSession, DriverSubmission, RuntimeEvent } from "../types.ts";

/** CLI protocol and prompt policy stay outside the shared turn coordinator. */
export class CliRuntimeSession extends AgyRuntime implements DriverSession {
  readonly driver = "cli" as const;
  private readonly allowedToolNames: ReadonlySet<string>;
  private readonly errorState: ConversationErrorState;

  constructor(options: ConstructorParameters<typeof AgyRuntime>[0], allowedToolNames: ReadonlySet<string>, errorState: ConversationErrorState) {
    super(options);
    this.allowedToolNames = allowedToolNames;
    this.errorState = errorState;
  }

  onRuntimeEvent(handler: (event: RuntimeEvent) => void): () => void {
    const translator = new CliEventTranslator({
      allowedToolNames: this.allowedToolNames, errorState: this.errorState,
    });
    return this.onEvent((event, source) => translator.translate(event, source, handler));
  }

  formatContextUpdate(messages: readonly Message[]): string {
    return formatContextUpdate(messages, "pending_tool_continuation");
  }

  async submit(input: DriverSubmission): Promise<void> {
    let prompt = formatContextPrompt(input.context, !input.reconstructContext, input.syncedMessageCount);
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
      reconstructContext: input.reconstructContext, prompt,
    });
    if (!input.beforeInput()) return;
    await this.send({ event: "user", message: { content: prompt } });
  }
}
