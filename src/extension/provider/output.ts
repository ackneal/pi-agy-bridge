import type { ToolCall } from "@earendil-works/pi-ai";
import { fromMcpToolName } from "../bridge/capabilities.ts";
import type { RuntimeEvent } from "../drivers/types.ts";
import { PiEventWriter, type PiEventWriterOptions } from "./events.ts";

export interface PiRuntimeOutputOptions extends PiEventWriterOptions {
  allowedToolNames?: ReadonlySet<string>;
  onBlockedTool?: (name: string) => void;
  allowLegacyNativeToolCalls?: boolean;
}

/** Shared Pi output and MCP handoff policy. Native drivers supply only facts. */
export class PiRuntimeOutput {
  private readonly writer: PiEventWriter;
  private readonly options: PiRuntimeOutputOptions;
  public readonly stream: PiEventWriter["stream"];

  constructor(options: PiRuntimeOutputOptions) {
    this.options = options;
    this.writer = new PiEventWriter(options);
    this.stream = this.writer.stream;
  }

  get message() { return this.writer.message; }
  setModel(model: string): void { this.writer.setModel(model); }
  isCompleted(): boolean { return this.writer.isCompleted(); }
  handleTermination(reason: "error" | "aborted", error?: string): void { this.writer.handleTermination(reason, error); }

  handleRuntimeEvent(event: RuntimeEvent): void {
    if (this.isCompleted()) return;

    switch (event.type) {
      case "start": this.writer.ensureStarted(); break;
      case "text-close": this.writer.closeActiveText(); break;
      case "session-reference": this.writer.setResponseId(event.reference); break;
      case "text-delta": this.writer.appendTextDelta(event.delta); break;
      case "usage": this.writer.setUsage(event.usage); break;
      case "tool-call":
        if (this.options.allowLegacyNativeToolCalls) this.writer.appendToolCall(event.toolCall);
        else this.blockTool(event.toolCall.name);
        break;
      case "complete":
        if (event.reason === "error" || event.reason === "aborted") {
          this.writer.handleTermination(event.reason, event.error);
        } else {
          this.writer.finish(event.reason === "stop" ? undefined : event.reason);
        }
        break;
      case "blocked-native-tool": this.blockTool(event.name); break;
    }
  }

  handleBridgeToolCalls(calls: readonly ToolCall[]): void {
    if (this.isCompleted() || calls.length === 0) return;

    const blocked = calls.find((call) => this.options.allowedToolNames !== undefined &&
      !this.options.allowedToolNames.has(fromMcpToolName(call.name)));
    if (blocked) {
      this.blockTool(blocked.name);
      return;
    }

    for (const call of calls) this.writer.appendToolCall(call);
    this.writer.finish("toolUse");
  }

  private blockTool(name: string): void {
    this.handleTermination("error", `The model attempted to call an unavailable tool: ${name}`);
    this.options.onBlockedTool?.(name);
  }
}
