import type { AnyModel, AssistantMessage, Context, Message, Model, ProviderAuthInteraction, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import type { LiveSession } from "../session/session.ts";
import type { RuntimeSessionStore, RuntimeSessionSync } from "../session/state.ts";
import type { BridgeIPC } from "../bridge/ipc.ts";
import type { AgyUsage } from "../runtime/usage.ts";

export interface DriverInstallationProgress {
  phase: "download" | "verify" | "extract" | "validate" | "complete" | "error" | "cancelled";
  version: string;
  platform: string;
  message: string;
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface DriverAuthentication {
  label: string;
  /** Checks existing authentication without prompting or opening a browser. */
  probe(signal: AbortSignal, onUsage: (usage: AgyUsage) => void): Promise<boolean>;
  /** Allows explicit authentication interaction and confirms authentication before returning. */
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
  store: Pick<RuntimeSessionStore, "get" | "delete">;
  sync: Pick<RuntimeSessionSync, "decide">;
  preparationId: symbol;
}

export interface BridgeDriver {
  readonly id: DriverId;
  readonly label: string;
  /** Covers stored session fields and the shared history fingerprint algorithm. */
  readonly sessionVersion: string;
  readonly authentication: DriverAuthentication;
  readonly initialModels: readonly AnyModel[];
  readonly pluginError?: DriverFailure | undefined;
  onInstallationProgress?: ((progress: DriverInstallationProgress) => void) | undefined;
  validateSelection(model: Model<any>, options: SimpleStreamOptions | undefined): void;
  /** Returns the runtime already owned by input.session, whether reused or newly installed. */
  prepareSession(input: PrepareDriverInput): Promise<{ proc: DriverSession; mcpServer: BridgeIPC; reconstructContext: boolean; modelId: string }>;
  /** Undefined retains the cached/default catalog when safe discovery is unavailable. */
  discoverModels(signal: AbortSignal): Promise<AnyModel[] | undefined>;
  /** Undefined means quota is unavailable; authentication must be checked via probe instead. */
  usage(signal: AbortSignal): Promise<AgyUsage | undefined>;
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
  /** Working directory and driver-specific constraints that must match to reuse or restore a conversation. */
  readonly compatibilityKey?: string | undefined;
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
  | { type: "tool-warning"; name: string; args: unknown };
