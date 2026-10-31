import type { RuntimeEvent } from "../types.ts";
import type { AgyEvent, AgyResultEvent, AgyStepUpdateEvent, AgyUsage } from "../../shared/types.ts";
import { AGY_MCP_PREFIX, isAllowedPiToolName } from "../../bridge/capabilities.ts";
import { debugLog } from "../../shared/debug.ts";

const AGY_INTERNAL_TOOL_NAMES = new Set(["list_resources", "call_mcp_tool", "manage_task", "view_file"]);

export interface ConversationErrorState {
  conversationId?: string | undefined;
  lastError?: string | undefined;
}

export interface CliEventTranslatorOptions {
  errorState?: ConversationErrorState | undefined;
  allowedToolNames?: ReadonlySet<string>;
}

export class EventTranslator {
  private errorState: ConversationErrorState;
  private readonly allowedToolNames: ReadonlySet<string> | undefined;
  private hasStepUsage = false;
  private completedResponse = false;
  private hasTurnError = false;
  private responseId: string | undefined;
  private emit: (event: RuntimeEvent) => void = () => {};

  constructor(options: CliEventTranslatorOptions = {}) {
    this.errorState = options.errorState ?? {};
    this.allowedToolNames = options.allowedToolNames;
  }

  public translate(event: AgyEvent, source: "agy" | "runtime", emit: (event: RuntimeEvent) => void): void {
    this.emit = emit;
    if (source === "runtime") {
      const result = event as AgyResultEvent;
      this.emit({ type: "complete", reason: "error", error: (typeof result.error === "string" ? result.error : result.error?.message) || undefined, resumable: false });
      return;
    }

    switch (event.event) {
      case "init":
        if (typeof event["conversation_id"] === "string") {
          this.setResponseId(event["conversation_id"]);
        }
        this.emit({ type: "start" });
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
        debugLog("events", `Unhandled Antigravity CLI event type: "${event.event}"`);
        break;
    }
  }

  private handleStepUpdate(step: AgyStepUpdateEvent): void {
    const stepType = step.update_type ?? step.type ?? step.step_type;
    if (stepType === "user_input") {
      this.completedResponse = false;
      this.hasTurnError = false;
    } else if (stepType === "error_message") {
      this.hasTurnError = true;
    } else if (stepType === "agent_response") {
      this.completedResponse = step.state === "DONE";
    }

    if (step.usage) {
      debugLog("usage", "Antigravity CLI step usage:", step.usage);
      this.hasStepUsage = true;
      this.addUsage(step.usage);
    }

    const deltaText = this.extractTextDelta(step);
    if (deltaText !== null) {
      this.emit({ type: "start" });
      this.emit({ type: "text-delta", delta: deltaText });
    }

    const tool = this.selectToolName(step);
    if (tool !== null) {
      const blockedTool = this.getBlockedAgyToolName(tool.name);
      if (blockedTool !== undefined) {
        this.blockTool(blockedTool);
        return;
      }

      debugLog("events", `Waiting for MCP bridge or internal coordination: ${String(tool.name)}`);
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

  private selectToolName(step: AgyStepUpdateEvent): { name: unknown } | null {
    // A nested call owns its name, even when malformed; never use a flat fallback.
    if (step.tool_call) return { name: step.tool_call.name };

    const stepType = step.update_type ?? step.type ?? step.step_type;
    if (stepType !== "tool") return null;
    if ("tool_name" in step) return { name: step.tool_name };
    if ("name" in step) return { name: step["name"] };

    return null;
  }

  private getBlockedAgyToolName(name: unknown): string | undefined {
    if (name === undefined) return "<unnamed>";
    if (name !== null && typeof name === "object") return "<invalid>";
    if (typeof name !== "string") return String(name);
    if (name.length === 0) return name;
    if (AGY_INTERNAL_TOOL_NAMES.has(name) || this.isAllowedAgyTool(name)) return undefined;

    return name;
  }

  private isAllowedAgyTool(name: string): boolean {
    if (this.allowedToolNames === undefined) return true;
    if (this.allowedToolNames.has(name)) return true;

    const bridgedNames = new Set(
      [...this.allowedToolNames].map((toolName) => `${AGY_MCP_PREFIX}${toolName}`)
    );
    return isAllowedPiToolName(name, bridgedNames);
  }

  private blockTool(name: string): void {
    debugLog("security", `Blocked Antigravity CLI tool call outside the Pi bridge allowlist: ${name}`);
    this.emit({ type: "blocked-native-tool", name });
  }

  private handleResult(result: AgyResultEvent): void {
    this.emit({ type: "start" });
    this.emit({ type: "text-close" });

    debugLog("usage", "Antigravity CLI result accounting fields:", Object.fromEntries(
      Object.entries(result).filter(([key]) => /usage|token|metric|stat|metadata/i.test(key))
    ));
    if (result.usage && !this.hasStepUsage) {
      this.addUsage(result.usage);
    }

    if (result.conversation_id || result.session_id) {
      this.setResponseId((result.conversation_id ?? result.session_id) as string);
    }

    debugLog("events", "Antigravity CLI result outcome:", { status: result.status, error: result.error });

    const status = result.status?.toLowerCase();
    const conversationId = this.responseId ?? this.errorState.conversationId;
    if (conversationId !== this.errorState.conversationId) {
      this.errorState.conversationId = conversationId;
      this.errorState.lastError = undefined;
    }
    const error = typeof result.error === "string" ? result.error : result.error?.message;
    const historicalError = status === "error" && conversationId !== undefined &&
      error !== undefined && error === this.errorState.lastError && this.completedResponse && !this.hasTurnError;
    if (status === "success") this.errorState.lastError = undefined;
    if (historicalError) {
      debugLog("events", "Ignored historical Antigravity CLI error after completed response:", { conversationId, error });
    }
    if (!historicalError && (status === "aborted" || status === "error" || (status !== "success" && result.error))) {
      const reason = status === "aborted" ? "aborted" : "error";
      if (reason === "error") this.errorState.lastError = error;
      const errorMessage = result.error || reason === "error"
        ? (typeof result.error === "string" ? result.error : result.error?.message ?? "agy execution reported error status")
        : undefined;
      this.emit({ type: "complete", reason, error: errorMessage, resumable: true });
      return;
    }

    this.emit({ type: "complete", reason: "stop", resumable: true });
  }

  private addUsage(agyUsage: AgyUsage): void {
    const input = agyUsage.input_tokens ?? 0;
    const output = agyUsage.output_tokens ?? 0;
    const cacheRead = agyUsage.cache_read_tokens ?? 0;
    const reasoning = agyUsage.thinking_tokens ?? 0;
    // Each step's usage describes that single model request. Antigravity CLI's total_tokens
    // field omits cache_read_tokens, so compute the true per-request context size
    // ourselves; keep the latest snapshot for Pi's overflow/compaction checks.
    this.emit({ type: "usage", usage: {
      input,
      output,
      cacheRead,
      cacheWrite: 0,
      ...(reasoning > 0 ? { reasoning } : {}),
      totalTokens: input + output + cacheRead,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    } });
  }

  private setResponseId(reference: string): void {
    this.responseId = reference;
    this.emit({ type: "session-reference", reference });
  }

}
