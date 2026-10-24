import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, TextContent, ToolCall } from "@earendil-works/pi-ai";
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
  private currentTextIndex: number | null = null;
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
    if (this.completed) return;

    this.ensureStarted();
    if (this.currentTextIndex === null) {
      const textBlock: TextContent = {
        type: "text",
        text: "",
      };
      this.partial.content.push(textBlock);
      this.currentTextIndex = this.partial.content.length - 1;

      this.stream.push({
        type: "text_start",
        contentIndex: this.currentTextIndex,
        partial: this.snapshot(),
      });
    }

    (this.partial.content[this.currentTextIndex] as TextContent).text += delta;

    this.stream.push({
      type: "text_delta",
      contentIndex: this.currentTextIndex,
      delta,
      partial: this.snapshot(),
    });
  }

  public closeActiveText(): void {
    if (this.currentTextIndex !== null) {
      const index = this.currentTextIndex;
      const content = (this.partial.content[index] as TextContent).text;
      this.currentTextIndex = null;

      this.stream.push({
        type: "text_end",
        contentIndex: index,
        content,
        partial: this.snapshot(),
      });
    }
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
