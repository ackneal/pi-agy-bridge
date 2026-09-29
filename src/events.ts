import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  JsonObject,
  StopReason,
  TextContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgyEvent, AgyResultEvent, AgyStepUpdateEvent, AgyUsage } from "./types.ts";
import { AGY_MCP_PREFIX, fromMcpToolName, isAllowedPiToolName } from "./capabilities.ts";
import { debugLog } from "./debug.ts";

const AGY_INTERNAL_TOOL_NAMES = new Set(["list_resources", "call_mcp_tool", "manage_task"]);

export interface AgyEventAdapterOptions {
  model: string;
  provider?: string;
  stream?: AssistantMessageEventStream;
  allowedToolNames?: ReadonlySet<string>;
  bridgeToolCallsExternally?: boolean;
  onBlockedTool?: (name: string) => void;
}

export class PiEventAdapter {
  public readonly stream: AssistantMessageEventStream;
  private readonly model: string;
  private readonly provider: string;
  private readonly allowedToolNames: ReadonlySet<string> | undefined;
  private readonly bridgeToolCallsExternally: boolean;
  private readonly onBlockedTool: ((name: string) => void) | undefined;

  private started = false;
  private completed = false;
  private currentTextIndex: number | null = null;
  private currentText = "";
  private toolCallCount = 0;
  private hasStepUsage = false;

  private partial: AssistantMessage;

  constructor(options: AgyEventAdapterOptions) {
    this.model = options.model;
    this.provider = options.provider ?? "agy";
    this.allowedToolNames = options.allowedToolNames;
    this.bridgeToolCallsExternally = options.bridgeToolCallsExternally ?? false;
    this.onBlockedTool = options.onBlockedTool;
    this.stream = options.stream ?? createAssistantMessageEventStream();

    this.partial = {
      role: "assistant",
      content: [],
      api: "agy" as any,
      provider: this.provider,
      model: this.model,
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

  public isCompleted(): boolean {
    return this.completed;
  }

  public get message(): AssistantMessage {
    return this.snapshot();
  }

  public handleEvent(event: AgyEvent): void {
    if (this.completed) {
      debugLog("events", `Ignoring event after stream completed: ${event.event}`);
      return;
    }

    switch (event.event) {
      case "init":
        if (typeof event["conversation_id"] === "string") {
          this.partial.responseId = event["conversation_id"];
        }
        this.ensureStarted();
        break;

      case "step_update": {
        const update = event as AgyStepUpdateEvent;
        this.handleStepUpdate({
          ...update.step_update,
          ...update,
          event: "step_update",
        });
        break;
      }

      case "result": {
        const result = event as AgyResultEvent;
        this.handleResult({
          ...result.result,
          ...result,
          event: "result",
        });
        break;
      }

      default:
        debugLog("events", `Unhandled agy event type: "${event.event}"`);
        break;
    }
  }

  public handleTermination(
    reason: "error" | "aborted",
    errorMessage?: string
  ): void {
    if (this.completed) return;

    this.ensureStarted();
    this.closeActiveText();

    this.partial.stopReason = reason;
    if (errorMessage) {
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

  private ensureStarted(): void {
    if (!this.started) {
      this.started = true;
      this.stream.push({
        type: "start",
        partial: this.snapshot(),
      });
    }
  }

  public handleBridgeToolCalls(toolCalls: readonly ToolCall[]): void {
    if (this.completed || toolCalls.length === 0) return;

    const blocked = toolCalls.find((call) => !this.isAllowedBridgeTool(call.name));
    if (blocked) {
      this.blockTool(blocked.name);
      return;
    }

    this.ensureStarted();
    for (const toolCall of toolCalls) {
      this.appendToolCall(toolCall);
    }

    this.partial.stopReason = "toolUse";
    this.completed = true;
    const message = this.snapshot();
    debugLog("usage", "Pi done message usage (bridge tool call):", message.usage);
    this.stream.push({
      type: "done",
      reason: "toolUse",
      message,
    });
  }

  private handleStepUpdate(step: AgyStepUpdateEvent): void {
    if (step.usage) {
      debugLog("usage", "AGY step usage:", step.usage);
      this.hasStepUsage = true;
      this.addUsage(step.usage);
    }

    const deltaText = this.extractTextDelta(step);
    if (deltaText !== null) {
      this.ensureStarted();
      this.appendTextDelta(deltaText);
    }

    const toolCall = this.extractToolCall(step);
    if (toolCall !== null) {
      if (AGY_INTERNAL_TOOL_NAMES.has(toolCall.name)) {
        debugLog("events", `Allowing AGY internal coordination tool: ${toolCall.name}`);
      } else if (!this.isAllowedAgyTool(toolCall.name)) {
        this.blockTool(toolCall.name);
      } else if (this.bridgeToolCallsExternally) {
        debugLog("events", `Waiting for MCP bridge to relay tool call: ${toolCall.name}`);
      } else {
        this.ensureStarted();
        this.appendToolCall(toolCall);
      }
      return;
    }

    if (deltaText === null) {
      debugLog("events", "Step update without text delta or tool call:", step);
    }
  }

  private extractTextDelta(step: AgyStepUpdateEvent): string | null {
    if (typeof step.text_delta === "string" && step.text_delta.length > 0) {
      return step.text_delta;
    }

    if (typeof step.delta === "string" && step.delta.length > 0) {
      return step.delta;
    }

    if (step.delta && typeof step.delta === "object" && typeof step.delta.text === "string" && step.delta.text.length > 0) {
      return step.delta.text;
    }

    const stepType = step.update_type ?? step.type ?? step.step_type;
    if (stepType === "agent_response") {
      if (typeof step.text === "string" && step.text.length > 0) {
        return step.text;
      }
      if (typeof step.content === "string" && step.content.length > 0) {
        return step.content;
      }
    }

    return null;
  }

  private appendTextDelta(delta: string): void {
    if (this.currentTextIndex === null) {
      const textBlock: TextContent = {
        type: "text",
        text: "",
      };
      this.partial.content.push(textBlock);
      this.currentTextIndex = this.partial.content.length - 1;
      this.currentText = "";

      this.stream.push({
        type: "text_start",
        contentIndex: this.currentTextIndex,
        partial: this.snapshot(),
      });
    }

    this.currentText += delta;
    (this.partial.content[this.currentTextIndex] as TextContent).text = this.currentText;

    this.stream.push({
      type: "text_delta",
      contentIndex: this.currentTextIndex,
      delta,
      partial: this.snapshot(),
    });
  }

  private closeActiveText(): void {
    if (this.currentTextIndex !== null) {
      const index = this.currentTextIndex;
      const content = this.currentText;
      this.currentTextIndex = null;
      this.currentText = "";

      this.stream.push({
        type: "text_end",
        contentIndex: index,
        content,
        partial: this.snapshot(),
      });
    }
  }

  private extractToolCall(step: AgyStepUpdateEvent): ToolCall | null {
    if (step.tool_call) {
      const tc = step.tool_call;
      const args = typeof tc.arguments === "string"
        ? this.safeParseJson(tc.arguments)
        : (tc.arguments ?? (typeof tc.input === "string" ? this.safeParseJson(tc.input) : tc.input) ?? {});

      return {
        type: "toolCall",
        id: tc.id || `call_${Date.now()}_${++this.toolCallCount}`,
        name: tc.name,
        arguments: args as JsonObject,
      };
    }

    const stepType = step.update_type ?? step.type ?? step.step_type;
    if (stepType === "tool" && (step.tool_name || step["name"])) {
      const name = (step.tool_name ?? step["name"]) as string;
      const id = (step.call_id ?? (step as Record<string, unknown>)["id"] ?? `call_${Date.now()}_${++this.toolCallCount}`) as string;
      const rawInput = step.tool_input ?? step["input"] ?? step["arguments"] ?? {};
      const args = typeof rawInput === "string" ? this.safeParseJson(rawInput) : rawInput;

      return {
        type: "toolCall",
        id,
        name,
        arguments: args as JsonObject,
      };
    }

    return null;
  }

  private appendToolCall(toolCall: ToolCall): void {
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

  private isAllowedAgyTool(name: string): boolean {
    if (this.allowedToolNames === undefined) return true;
    if (this.allowedToolNames.has(name)) return true;

    const bridgedNames = new Set(
      [...this.allowedToolNames].map((toolName) => `${AGY_MCP_PREFIX}${toolName}`)
    );
    return isAllowedPiToolName(name, bridgedNames);
  }

  private isAllowedBridgeTool(name: string): boolean {
    return this.allowedToolNames === undefined || this.allowedToolNames.has(fromMcpToolName(name));
  }

  private blockTool(name: string): void {
    debugLog("security", `Blocked Agy tool call outside the Pi bridge allowlist: ${name}`);
    this.handleTermination("error", `AgY attempted to call an unavailable tool: ${name}`);
    this.onBlockedTool?.(name);
  }

  private handleResult(result: AgyResultEvent): void {
    this.ensureStarted();
    this.closeActiveText();

    debugLog("usage", "AGY result accounting fields:", Object.fromEntries(
      Object.entries(result).filter(([key]) => /usage|token|metric|stat|metadata/i.test(key))
    ));
    if (result.usage) {
      if (this.hasStepUsage) this.mergeFinalUsage(result.usage);
      else this.addUsage(result.usage);
    }

    if (result.conversation_id || result.session_id) {
      this.partial.responseId = (result.conversation_id ?? result.session_id) as string;
    }

    const status = result.status ?? "success";
    if (status === "error" || result.error) {
      const errorMsg = typeof result.error === "string"
        ? result.error
        : result.error?.message ?? "agy execution reported error status";

      this.partial.stopReason = "error";
      this.partial.errorMessage = errorMsg;

      this.completed = true;
      this.stream.push({
        type: "error",
        reason: "error",
        error: this.snapshot(),
      });
      return;
    }

    if (status === "aborted") {
      this.partial.stopReason = "aborted";
      this.completed = true;
      this.stream.push({
        type: "error",
        reason: "aborted",
        error: this.snapshot(),
      });
      return;
    }

    const hasToolCall = this.partial.content.some((c) => c.type === "toolCall");
    const stopReason: Extract<StopReason, "stop" | "toolUse"> = hasToolCall ? "toolUse" : "stop";

    this.partial.stopReason = stopReason;
    this.completed = true;
    const message = this.snapshot();
    debugLog("usage", "Pi done message usage (AGY result):", message.usage);

    this.stream.push({
      type: "done",
      reason: stopReason,
      message,
    });
  }

  private addUsage(agyUsage: AgyUsage): void {
    const input = agyUsage.input_tokens ?? 0;
    const output = agyUsage.output_tokens ?? 0;
    const cacheRead = agyUsage.cache_read_tokens ?? 0;
    const reasoning = agyUsage.thinking_tokens ?? 0;
    const totalTokens = agyUsage.total_tokens ?? (input + output);
    const current = this.partial.usage;

    this.partial.usage = {
      input: current.input + input,
      output: current.output + output,
      cacheRead: current.cacheRead + cacheRead,
      cacheWrite: 0,
      ...((current.reasoning ?? 0) + reasoning > 0
        ? { reasoning: (current.reasoning ?? 0) + reasoning }
        : {}),
      totalTokens: current.totalTokens + totalTokens,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    };
  }

  private mergeFinalUsage(agyUsage: AgyUsage): void {
    const current = this.partial.usage;
    const reasoning = Math.max(current.reasoning ?? 0, agyUsage.thinking_tokens ?? 0);

    this.partial.usage = {
      ...current,
      input: Math.max(current.input, agyUsage.input_tokens ?? 0),
      output: Math.max(current.output, agyUsage.output_tokens ?? 0),
      cacheRead: Math.max(current.cacheRead, agyUsage.cache_read_tokens ?? 0),
      ...(reasoning > 0 ? { reasoning } : {}),
      totalTokens: Math.max(
        current.totalTokens,
        agyUsage.total_tokens ?? ((agyUsage.input_tokens ?? 0) + (agyUsage.output_tokens ?? 0))
      ),
    };
  }

  private safeParseJson(val: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(val);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      return { raw: val };
    }
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

export { PiEventAdapter as AgyEventAdapter };
