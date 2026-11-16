import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export interface PiEventWriterOptions {
  model: string;
  provider?: string;
  stream?: AssistantMessageEventStream;
}

/** Constructs Pi events from driver-normalized facts, without runtime policy. */
export class PiEventWriter {
  public readonly stream: AssistantMessageEventStream;
  private started = false;
  private completed = false;
  private currentContentIndex: number | null = null;
  private partial: AssistantMessage;

  constructor(options: PiEventWriterOptions) {
    this.stream = options.stream ?? createAssistantMessageEventStream();
    this.partial = {
      role: "assistant",
      content: [],
      api: "agy" as any,
      provider: options.provider ?? "agy",
      model: options.model,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  public get message(): AssistantMessage {
    return this.snapshot();
  }

  public setResponseId(responseId: string): void {
    this.partial.responseId = responseId;
  }

  public setUsage(usage: AssistantMessage["usage"]): void {
    this.partial.usage = usage;
  }

  public finish(reason?: "stop" | "toolUse"): void {
    if (this.completed) return;

    this.ensureStarted();
    this.closeActiveText();
    const stopReason = reason ?? (this.partial.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop");
    this.partial.stopReason = stopReason;
    this.completed = true;
    this.stream.push({ type: "done", reason: stopReason, message: this.snapshot() });
  }

  public setModel(model: string): void {
    if (this.started) {
      throw new Error("Cannot change model after the stream has started");
    }

    this.partial.model = model;
  }

  public isCompleted(): boolean {
    return this.completed;
  }

  public handleTermination(
    reason: "error" | "aborted",
    errorMessage?: string
  ): void {
    if (this.completed) return;

    this.ensureStarted();
    this.closeActiveText();

    this.partial.stopReason = reason;
    if (errorMessage !== undefined) {
      this.partial.errorMessage = errorMessage;
    }

    const errorEvent: AssistantMessageEvent = {
      type: "error",
      reason,
      error: this.snapshot(),
    };

    this.completed = true;
    this.stream.push(errorEvent);
  }

  public ensureStarted(): void {
    if (!this.started) {
      this.started = true;
      this.stream.push({
        type: "start",
        partial: this.snapshot(),
      });
    }
  }

  public appendTextDelta(delta: string): void {
    this.appendContentDelta("text", delta);
  }

  public appendThinkingDelta(delta: string): void {
    this.appendContentDelta("thinking", delta);
  }

  private appendContentDelta(kind: "text" | "thinking", delta: string): void {
    if (this.completed || (kind === "thinking" && delta.length === 0)) return;

    this.ensureStarted();
    if (this.currentContentIndex !== null && this.partial.content[this.currentContentIndex]?.type !== kind) {
      this.closeActiveText();
    }
    if (this.currentContentIndex === null) {
      const block: TextContent | ThinkingContent = kind === "text"
        ? { type: "text", text: "" }
        : { type: "thinking", thinking: "" };
      this.partial.content.push(block);
      this.currentContentIndex = this.partial.content.length - 1;

      this.stream.push({
        type: `${kind}_start`,
        contentIndex: this.currentContentIndex,
        partial: this.snapshot(),
      });
    }

    const block = this.partial.content[this.currentContentIndex] as TextContent | ThinkingContent;
    if (block.type === "text") block.text += delta;
    else block.thinking += delta;

    this.stream.push({
      type: `${kind}_delta`,
      contentIndex: this.currentContentIndex,
      delta,
      partial: this.snapshot(),
    });
  }

  public closeActiveText(): void {
    if (this.completed || this.currentContentIndex === null) return;

    const index = this.currentContentIndex;
    const block = this.partial.content[index] as TextContent | ThinkingContent;
    this.currentContentIndex = null;

    this.stream.push({
      type: `${block.type}_end`,
      contentIndex: index,
      content: block.type === "text" ? block.text : block.thinking,
      partial: this.snapshot(),
    });
  }

  public appendToolCall(toolCall: ToolCall): void {
    if (this.completed) return;

    this.ensureStarted();
    this.closeActiveText();

    this.partial.content.push(toolCall);
    const contentIndex = this.partial.content.length - 1;

    this.stream.push({
      type: "toolcall_start",
      contentIndex,
      partial: this.snapshot(),
    });

    const serializedArgs = JSON.stringify(toolCall.arguments);
    if (serializedArgs) {
      this.stream.push({
        type: "toolcall_delta",
        contentIndex,
        delta: serializedArgs,
        partial: this.snapshot(),
      });
    }

    this.stream.push({
      type: "toolcall_end",
      contentIndex,
      toolCall,
      partial: this.snapshot(),
    });
  }

  private snapshot(): AssistantMessage {
    return {
      ...this.partial,
      content: this.partial.content.map((block) => {
        if (block.type === "text") {
          return { ...block };
        }
        if (block.type === "toolCall") {
          return {
            ...block,
            arguments: { ...block.arguments },
          };
        }
        return { ...block };
      }),
      usage: {
        ...this.partial.usage,
        cost: { ...this.partial.usage.cost },
      },
    };
  }
}
