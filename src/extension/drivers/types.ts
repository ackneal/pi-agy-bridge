import type { AssistantMessage, Context, Message, Model, SimpleStreamOptions, ToolCall } from "@earendil-works/pi-ai";

export type DriverId = "cli" | "acp";

export interface DriverSubmission {
  model: Model<any>;
  context: Context;
  options: SimpleStreamOptions | undefined;
  reconstructContext: boolean;
  syncedMessageCount: number;
  /** Revalidate ownership/cancellation immediately before native input delivery. */
  beforeInput(): boolean;
}

/** A live native prompt may span multiple Pi output/tool turns. */
export interface DriverSession {
  readonly driver: DriverId;
  readonly isRunning: boolean;
  onRuntimeEvent(handler: (event: RuntimeEvent) => void): () => void;
  formatContextUpdate(messages: readonly Message[]): string;
  submit(input: DriverSubmission): Promise<void>;
  abort(): Promise<void>;
}

/** Ordered driver facts; start/text-close preserve accounting snapshot boundaries. */
export type RuntimeEvent =
  | { type: "start" }
  | { type: "text-close" }
  | { type: "session-reference"; reference: string }
  | { type: "text-delta"; delta: string }
  | { type: "usage"; usage: AssistantMessage["usage"] }
  | { type: "complete"; reason: "stop" | "toolUse" | "error" | "aborted"; error?: string | undefined; resumable: boolean }
  | { type: "blocked-native-tool"; name: string }
  // Only legacy direct adapters execute native tool facts; shared MCP owns execution.
  | { type: "tool-call"; toolCall: ToolCall };
