import * as acp from "@agentclientprotocol/sdk";
import { isRetryableAssistantError, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { debugLog } from "../shared/debug.ts";
import { AuthenticationRequiredError, CompatibilityError } from "../shared/types.ts";

export type FailureOutcome = "retryable" | "non-retryable" | "unknown";

export type FailurePhase = "startup" | "initialization" | "pre-dispatch" | "active-prompt" | "tool-handoff";

export interface FailureContext {
  phase: FailurePhase;
  hasPendingToolCalls?: boolean;
  hasCompletedToolCalls?: boolean;
  expected?: boolean;
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function matchesPiRetryableError(errorMessage: string): boolean {
  const probe: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "agy",
    provider: "agy",
    model: "probe",
    usage: ZERO_USAGE,
    stopReason: "error",
    errorMessage,
    timestamp: 0,
  };
  return isRetryableAssistantError(probe);
}

const NON_RETRYABLE_ERRNO_CODES = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "EISDIR",
  "ENOTDIR",
  "EINVAL",
  "ENOEXEC",
]);

const TRANSIENT_ERRNO_CODES = new Set([
  "EPIPE",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EOF",
]);

const NON_RETRYABLE_MESSAGE_PATTERN = new RegExp([
  "\\b(?:authentication required|not authenticated|unauthenticated|login required|log in|sign in|authorization denied|permission denied|unauthorized|forbidden|invalid api key|api key not valid)\\b",
  "\\b(?:quota exceeded|insufficient_quota|out of budget|billing|monthly usage limit reached|available balance|GoUsageLimitError|FreeUsageLimitError|subscription_sharing_usage_limit_exceeded|subscription_sharing_workplace_individual_usage_limit_exceeded)\\b",
  "\\b(?:unsupported|required configuration is unavailable|did not apply the requested|does not support session loading|must advertise|invalid acp|empty session id|prompt already active|must not be empty|unavailable tool|superseded|cancelled|aborted|disposed)\\b",
  "\\b(?:ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|EINVAL|ENOEXEC)\\b",
  "\\b(?:prompt (?:is )?too long|request_too_large|exceeds the context window|context[_ ]length[_ ]exceeded|too many tokens|token limit exceeded)\\b",
].join("|"), "i");

function extractDataDetails(data: unknown): string | undefined {
  if (typeof data === "string" && data.trim()) return data.trim();
  if (!data || typeof data !== "object") return undefined;

  const record = data as Record<string, unknown>;
  for (const key of ["details", "message", "reason", "error"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const nested = extractDataDetails(value);
      if (nested) return nested;
    }
  }
  return undefined;
}

export function extractFailureMessage(error: unknown): string {
  if (error instanceof acp.RequestError) {
    const details = extractDataDetails(error.data);
    if (details && !error.message.includes(details)) {
      if (/^internal error$/i.test(error.message.trim())) {
        return details;
      }
      return `${error.message}: ${details}`;
    }
    return error.message;
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string" && code && !error.message.includes(code)) {
      return `${error.message} (${code})`;
    }
    return error.message;
  }
  return String(error);
}

function isTransportOrProcessFailure(error: unknown, message: string): boolean {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (typeof code === "string" && TRANSIENT_ERRNO_CODES.has(code)) {
    return true;
  }
  return /\b(?:ACP process closed|ACP transport closed|ACP connection is not running|ACP session is not running|ACP runtime closed before input delivery|write EPIPE|read ECONNRESET|broken pipe|socket hang up)\b/i.test(message);
}

function isTimeoutFailure(error: unknown, message: string): boolean {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === "ETIMEDOUT") return true;
  return /\b(?:ACP request timeout|ETIMEDOUT|timed? out|timeout)\b/i.test(message);
}

export function classifyFailure(error: unknown, context: FailureContext): FailureOutcome {
  if (context.expected) return "non-retryable";
  if (error instanceof AuthenticationRequiredError || error instanceof CompatibilityError) {
    return "non-retryable";
  }

  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (typeof code === "string" && NON_RETRYABLE_ERRNO_CODES.has(code)) {
    return "non-retryable";
  }

  const message = extractFailureMessage(error);
  if (error instanceof acp.RequestError) {
    if (error.code === -32000 || error.code === -32800 || error.code === -32600 || error.code === -32601 || error.code === -32602 || error.code === -32022) {
      return "non-retryable";
    }
  }

  if (NON_RETRYABLE_MESSAGE_PATTERN.test(message)) {
    return "non-retryable";
  }

  const hasToolActivity =
    context.phase === "tool-handoff" ||
    Boolean(context.hasPendingToolCalls) ||
    Boolean(context.hasCompletedToolCalls);

  if (hasToolActivity) {
    return "unknown";
  }

  if (context.phase === "active-prompt") {
    if (
      error instanceof acp.RequestError &&
      matchesPiRetryableError(message) &&
      !isTransportOrProcessFailure(error, message) &&
      !isTimeoutFailure(error, message)
    ) {
      return "retryable";
    }
    return "unknown";
  }

  if (isTimeoutFailure(error, message) || isTransportOrProcessFailure(error, message) || matchesPiRetryableError(message)) {
    return "retryable";
  }

  return "non-retryable";
}

const UNKNOWN_TOOL_ACTIVITY_SUFFIX = "(execution outcome unknown after tool activity; automatic replay disabled)";
const SAFE_UNKNOWN_TOOL_FALLBACK = `ACP turn failed ${UNKNOWN_TOOL_ACTIVITY_SUFFIX}`;
const SAFE_UNKNOWN_FALLBACK = "ACP turn failed with unknown execution outcome; automatic replay disabled";
const SAFE_NON_RETRYABLE_FALLBACK = "ACP request failed with a non-retryable error";

export function formatFailureMessage(error: unknown, context: FailureContext): {
  outcome: FailureOutcome;
  message: string;
} {
  const rawMessage = extractFailureMessage(error);
  const outcome = classifyFailure(error, context);

  if (outcome === "retryable") {
    if (matchesPiRetryableError(rawMessage)) {
      return { outcome, message: rawMessage };
    }
    return { outcome, message: `ACP connection error: ${rawMessage}` };
  }

  const hasToolActivity = Boolean(context.hasPendingToolCalls || context.hasCompletedToolCalls || context.phase === "tool-handoff");

  if (outcome === "unknown") {
    const candidate = hasToolActivity && !rawMessage.includes(UNKNOWN_TOOL_ACTIVITY_SUFFIX)
      ? `${rawMessage} ${UNKNOWN_TOOL_ACTIVITY_SUFFIX}`
      : rawMessage;
    if (!matchesPiRetryableError(candidate)) {
      return { outcome, message: candidate };
    }
    debugLog("session", "Replacing retry-matching message on unknown failure outcome:", rawMessage);
    return {
      outcome,
      message: hasToolActivity ? SAFE_UNKNOWN_TOOL_FALLBACK : SAFE_UNKNOWN_FALLBACK,
    };
  }

  if (!matchesPiRetryableError(rawMessage)) {
    return { outcome, message: rawMessage };
  }
  debugLog("session", "Replacing retry-matching message on non-retryable failure outcome:", rawMessage);
  return { outcome, message: SAFE_NON_RETRYABLE_FALLBACK };
}
