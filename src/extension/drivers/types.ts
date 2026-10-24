import type { AnyModel, AssistantMessage, Context, Message, Model, ProviderAuthInteraction, SimpleStreamOptions, Tool, ToolCall } from "@earendil-works/pi-ai";
import type { LiveSession } from "../session/session.ts";
import type { RuntimeSessionStore, RuntimeSessionSync } from "../session/session-state.ts";
import type { BridgeIPC } from "../bridge/bridge-ipc.ts";
import type { AgyUsage } from "../runtime/usage.ts";

export interface DriverAuthentication {
  label: string;
  probe(signal: AbortSignal, onUsage: (usage: AgyUsage) => void): Promise<boolean>;
  login(interaction: ProviderAuthInteraction, onUsage: (usage: AgyUsage) => void): Promise<void>;
}

export interface DriverFailure {
  time: string;
  message: string;
}

export interface PrepareDriverInput {
  model: Model<any>;
  context: Context;
  tools: readonly Tool[];
  options: SimpleStreamOptions | undefined;
  session: LiveSession;
  store: RuntimeSessionStore;
  sync: RuntimeSessionSync;
  preparationId: symbol;
}

export interface DriverDiagnostics {
  catalogModels: AnyModel[];
  authStatus: "authenticated" | "unauthenticated" | "unknown";
  authError: DriverFailure | undefined;
  discoveryError: DriverFailure | undefined;
  usage: AgyUsage | undefined;
  usageError: DriverFailure | undefined;
}

export interface BridgeDriver {
  readonly id: DriverId;
  readonly label: string;
  /** Covers stored session fields and the shared history fingerprint algorithm. */
  readonly sessionVersion: string;
  readonly authentication: DriverAuthentication;
  readonly initialModels: readonly AnyModel[];
  validateSelection(model: Model<any>, options: SimpleStreamOptions | undefined): void;
  prepareSession(input: PrepareDriverInput): Promise<{ proc: DriverSession; mcpServer: BridgeIPC; reconstructContext: boolean; modelId: string }>;
  discoverModels(signal: AbortSignal): Promise<AnyModel[]>;
  usage(signal: AbortSignal): Promise<AgyUsage | undefined>;
  doctor(input: DriverDiagnostics): Promise<string>;
  detectExecutable(): string | undefined;
}

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
