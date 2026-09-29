import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/**
 * Thrown when agy version requirements are not met or runtime protocol compatibility checks fail
 * (such as unbridged native tools detected in init event).
 */
export class CompatibilityError extends Error {
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(message: string, options?: { code?: string; details?: Record<string, unknown> }) {
    super(message);
    this.name = "CompatibilityError";
    this.code = options?.code ?? "COMPATIBILITY_ERROR";
    if (options?.details !== undefined) {
      this.details = options.details;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when an agy child process fails to spawn, crashes, or exits with a non-zero code.
 */
export class AgyProcessError extends Error {
  public readonly exitCode?: number | null;
  public readonly signal?: NodeJS.Signals | string | null;
  public readonly stderr?: string;

  constructor(
    message: string,
    options?: { exitCode?: number | null; signal?: NodeJS.Signals | string | null; stderr?: string }
  ) {
    super(message);
    this.name = "AgyProcessError";
    if (options?.exitCode !== undefined) {
      this.exitCode = options.exitCode;
    }
    if (options?.signal !== undefined) {
      this.signal = options.signal;
    }
    if (options?.stderr !== undefined) {
      this.stderr = options.stderr;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface AgyInput {
  event: "user";
  message: { content: string };
}

export interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export interface AgyInitEvent {
  event: "init";
  conversation_id?: string;
  session_id?: string;
  model?: string;
  tools?: (string | { name: string; description?: string })[];
  init?: {
    model?: string;
    tools?: (string | { name: string; description?: string })[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AgyStepUpdateEvent {
  event: "step_update";
  update_type?: "user_input" | "tool" | "agent_response" | string;
  type?: "user_input" | "tool" | "agent_response" | string;
  step_type?: "user_input" | "tool" | "agent_response" | string;
  delta?: string | { text?: string; reasoning?: string };
  text_delta?: string;
  text?: string;
  content?: string;
  tool_call?: {
    id: string;
    name: string;
    arguments?: string | Record<string, unknown>;
    input?: string | Record<string, unknown>;
  };
  tool_name?: string;
  call_id?: string;
  tool_input?: unknown;
  tool_result?: unknown;
  usage?: AgyUsage;
  step_update?: Omit<AgyStepUpdateEvent, "event" | "step_update">;
  [key: string]: unknown;
}

export interface AgyResultEvent {
  event: "result";
  status?: "success" | "error" | "aborted" | string;
  content?: string;
  text?: string;
  usage?: AgyUsage;
  error?: string | { message?: string };
  conversation_id?: string;
  session_id?: string;
  response?: string;
  result?: Omit<AgyResultEvent, "event" | "result">;
  [key: string]: unknown;
}

export type AgyEvent =
  | AgyInitEvent
  | AgyStepUpdateEvent
  | AgyResultEvent
  | { event: string; [key: string]: unknown };

export interface AgyBridgeConfig {
  agyPath?: string;
  minVersion?: string;
  agentName?: string;
  /** @deprecated Use pluginDir. */
  agentDir?: string;
  pluginDir?: string;
  debug?: boolean;
  models?: ProviderModelConfig[];
}
