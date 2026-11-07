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

const NON_RETRYABLE_MESSAGE_PATTERN = new RegExp([
  "\\b(?:authentication required|not authenticated|unauthenticated|login required|authorization denied|permission denied|unauthorized|forbidden|invalid api key|api key not valid)\\b",
  "\\b(?:quota exceeded|insufficient_quota|out of budget|billing|monthly usage limit reached|available balance|GoUsageLimitError|FreeUsageLimitError|subscription_sharing_usage_limit_exceeded|subscription_sharing_workplace_individual_usage_limit_exceeded)\\b",
  "\\b(?:unsupported|required configuration is unavailable|did not apply the requested|does not support session loading|must advertise|invalid acp|empty session id|prompt already active|must not be empty|unavailable tool|superseded|cancelled|aborted|disposed)\\b",
  "\\b(?:ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|EINVAL|ENOEXEC)\\b",
  "\\b(?:prompt (?:is )?too long|request_too_large|exceeds the context window|context[_ ]length[_ ]exceeded|too many tokens|token limit exceeded)\\b",
].join("|"), "i");

const TRANSIENT_RPC_MESSAGE_PATTERN = new RegExp([
  "\\b(?:overloaded|server_busy|servers are currently busy|currently experiencing high demand|model is at capacity|rate.?limit|too many requests|ResourceExhausted)\\b",
  "(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])",
  "\\b(?:service.?(?:is.?)?(?:temporarily.?)?unavailable|server.?error|internal.?error|provider.?returned.?(?:an.?)?error|unable to forward upstream|upstream.?request.?failed|upstream_stream_read_error|stream was interrupted|http/?2 stream failed)\\b",
  "\\b(?:network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|websocket.?closed|websocket.?error|ended without|stream ended before|stream disconnected before completion|pending stream has been canceled|retry delay|you can retry your request|try your request again|please retry your request)\\b",
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
  if (typeof code === "string" && ["EPIPE", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EOF"].includes(code)) {
    return true;
  }
  return /\b(?:ACP process closed|ACP transport closed|ACP connection is not running|ACP session is not running|ACP runtime closed before input delivery|write EPIPE|read ECONNRESET|broken pipe|socket hang up)\b/i.test(message);
}

function isTimeoutFailure(error: unknown, message: string): boolean {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === "ETIMEDOUT") return true;
  return /\b(?:ACP request timeout|ETIMEDOUT|timed? out|timeout)\b/i.test(message);
}

function sanitizeNonRetryableMessage(message: string): string {
  return message
    .replace(/overloaded/gi, "unavailable")
    .replace(/server_busy/gi, "agent_busy")
    .replace(/servers\s+are\s+currently\s+busy/gi, "agent is unavailable")
    .replace(/currently\s+experiencing\s+high\s+demand/gi, "unavailable")
    .replace(/model\s+is\s+at\s+capacity/gi, "model unavailable")
    .replace(/rate.?limit/gi, "throttled")
    .replace(/too\s+many\s+requests/gi, "request rejected")
    .replace(/(?:^|[^a-z0-9])(429|500|502|503|504|520|524)(?![a-z0-9])/gi, (match, code) => match.slice(0, match.length - code.length) + `http-${code[0]}x${code.slice(1)}`)
    .replace(/service.?(?:is.?)?(?:temporarily.?)?unavailable/gi, "service offline")
    .replace(/service_unavailable/gi, "service_offline")
    .replace(/resource_exhausted/gi, "quota_depleted")
    .replace(/deadline_exceeded/gi, "deadline_passed")
    .replace(/backend_error/gi, "agent_failure")
    .replace(/bad_gateway/gi, "gateway_failure")
    .replace(/server.?error/gi, "agent failure")
    .replace(/internal.?error/gi, "agent failure")
    .replace(/provider.?returned.?(?:an.?)?error/gi, "agent returned failure")
    .replace(/exceeded\s+request\s+buffer\s+limit\s+while\s+retrying\s+upstream/gi, "remote buffer limit")
    .replace(/unable\s+to\s+forward\s+upstream/gi, "remote forwarding failed")
    .replace(/upstream.?request.?failed/gi, "remote failed")
    .replace(/upstream_stream_read_error/gi, "remote_read_failure")
    .replace(/stream\s+was\s+interrupted/gi, "turn stopped")
    .replace(/http\/?2\s+stream\s+failed/gi, "transport stream failed")
    .replace(/network.?error/gi, "transport failure")
    .replace(/connection.?(?:error|refused|lost)/gi, "session closed")
    .replace(/other\s+side\s+closed/gi, "peer closed")
    .replace(/fetch\s+failed/gi, "request failed")
    .replace(/request\s+to\s+(\S+)\s+failed,\s+reason:/gi, "call to $1 failed:")
    .replace(/getaddrinfo|ENOTFOUND|EAI_AGAIN/gi, "dns_failure")
    .replace(/upstream.?connect/gi, "peer link")
    .replace(/upstream/gi, "remote")
    .replace(/reset\s+before\s+headers/gi, "closed before headers")
    .replace(/socket\s+hang\s+up/gi, "pipe closed")
    .replace(/socket\s+connection\s+was\s+closed/gi, "pipe was closed")
    .replace(/timed?\s+out/gi, "exceeded deadline")
    .replace(/timeout/gi, "deadline exceeded")
    .replace(/terminated/gi, "stopped")
    .replace(/websocket.?(?:closed|error)/gi, "channel closed")
    .replace(/ended\s+without/gi, "closed without")
    .replace(/stream\s+ended\s+before/gi, "turn ended before")
    .replace(/http2\s+request\s+did\s+not\s+get\s+a\s+response/gi, "request received no response")
    .replace(/stream\s+disconnected\s+before\s+completion/gi, "turn stopped before completion")
    .replace(/pending\s+stream\s+has\s+been\s+canceled/gi, "pending turn was canceled")
    .replace(/retry\s+delay/gi, "backoff window")
    .replace(/you\s+can\s+retry\s+your\s+request|try\s+your\s+request\s+again|please\s+retry\s+your\s+request/gi, "submit a new request")
    .replace(/ResourceExhausted/gi, "QuotaDepleted")
    .replace(/subscription_sharing_(?:usage|user)_unavailable/gi, "subscription_sharing_offline");
}

export function classifyFailure(error: unknown, context: FailureContext): FailureOutcome {
  if (context.expected) return "non-retryable";
  if (error instanceof AuthenticationRequiredError || error instanceof CompatibilityError) {
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

  const unsafeExecutionState =
    context.phase === "tool-handoff" ||
    Boolean(context.hasPendingToolCalls) ||
    Boolean(context.hasCompletedToolCalls);

  if (unsafeExecutionState) {
    return "unknown";
  }

  if (context.phase === "active-prompt") {
    if (error instanceof acp.RequestError && TRANSIENT_RPC_MESSAGE_PATTERN.test(message) && !isTransportOrProcessFailure(error, message) && !isTimeoutFailure(error, message)) {
      return "retryable";
    }
    return "unknown";
  }

  if (isTimeoutFailure(error, message) || isTransportOrProcessFailure(error, message) || TRANSIENT_RPC_MESSAGE_PATTERN.test(message)) {
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
    const sanitized = sanitizeNonRetryableMessage(rawMessage);
    const candidate = hasToolActivity && !sanitized.includes(UNKNOWN_TOOL_ACTIVITY_SUFFIX)
      ? `${sanitized} ${UNKNOWN_TOOL_ACTIVITY_SUFFIX}`
      : sanitized;
    if (!matchesPiRetryableError(candidate)) {
      return { outcome, message: candidate };
    }
    debugLog("session", "Falling back to safe unknown failure message to prevent automatic replay:", rawMessage);
    return {
      outcome,
      message: hasToolActivity ? SAFE_UNKNOWN_TOOL_FALLBACK : SAFE_UNKNOWN_FALLBACK,
    };
  }

  if (!matchesPiRetryableError(rawMessage)) {
    return { outcome, message: rawMessage };
  }
  const sanitized = sanitizeNonRetryableMessage(rawMessage);
  if (!matchesPiRetryableError(sanitized)) {
    return { outcome, message: sanitized };
  }
  debugLog("session", "Falling back to safe non-retryable failure message to prevent automatic replay:", rawMessage);
  return { outcome, message: SAFE_NON_RETRYABLE_FALLBACK };
}
