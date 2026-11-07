import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { isRetryableAssistantError, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { classifyFailure, extractFailureMessage, formatFailureMessage, type FailureContext, type FailureOutcome } from "./failure.ts";

const zeroUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createAssistantError(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "agy",
    provider: "agy",
    model: "gemini-3.8-flash",
    usage: zeroUsage,
    stopReason: "error",
    errorMessage,
    timestamp: 0,
  };
}

describe("extractFailureMessage", () => {
  const cases: { name: string; error: unknown; expected: string }[] = [
    {
      name: "extracts RequestError data.details",
      error: new acp.RequestError(-32603, "Internal error", { details: "Authentication required" }),
      expected: "Internal error: Authentication required",
    },
    {
      name: "extracts nested RequestError data.error.message",
      error: new acp.RequestError(-32603, "Internal error", { error: { message: "Quota exceeded for project" } }),
      expected: "Internal error: Quota exceeded for project",
    },
    {
      name: "avoids duplicating details already in RequestError message",
      error: new acp.RequestError(-32000, "Authentication required. Run /login to authenticate.", { details: "Authentication required" }),
      expected: "Authentication required. Run /login to authenticate.",
    },
    {
      name: "appends errno code when absent from Error message",
      error: Object.assign(new Error("write failed"), { code: "EPIPE" }),
      expected: "write failed (EPIPE)",
    },
    {
      name: "preserves Error message when errno code is already present",
      error: Object.assign(new Error("spawn /missing ENOENT"), { code: "ENOENT" }),
      expected: "spawn /missing ENOENT",
    },
  ];

  for (const row of cases) {
    test(row.name, () => {
      const actual = extractFailureMessage(row.error);

      assert.equal(actual, row.expected);
    });
  }
});

describe("classifyFailure and formatFailureMessage", () => {
  const cases: {
    name: string;
    error: unknown;
    context: FailureContext;
    expectedOutcome: FailureOutcome;
    expectedRetryableByPi: boolean;
    expectedPattern: RegExp;
  }[] = [
    {
      name: "process exit during startup is retryable",
      error: new Error("ACP process closed (23)"),
      context: { phase: "startup" },
      expectedOutcome: "retryable",
      expectedRetryableByPi: true,
      expectedPattern: /ACP connection error: ACP process closed \(23\)/,
    },
    {
      name: "transport closure during initialization is retryable",
      error: new Error("ACP transport closed"),
      context: { phase: "initialization" },
      expectedOutcome: "retryable",
      expectedRetryableByPi: true,
      expectedPattern: /ACP connection error: ACP transport closed/,
    },
    {
      name: "request timeout during initialization is retryable",
      error: new Error("ACP request timeout: initialize"),
      context: { phase: "initialization" },
      expectedOutcome: "retryable",
      expectedRetryableByPi: true,
      expectedPattern: /ACP request timeout: initialize/,
    },
    {
      name: "connection failure before prompt dispatch is retryable",
      error: new Error("ACP runtime closed before input delivery"),
      context: { phase: "pre-dispatch" },
      expectedOutcome: "retryable",
      expectedRetryableByPi: true,
      expectedPattern: /ACP connection error: ACP runtime closed before input delivery/,
    },
    {
      name: "EPIPE before prompt dispatch is retryable",
      error: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
      context: { phase: "pre-dispatch" },
      expectedOutcome: "retryable",
      expectedRetryableByPi: true,
      expectedPattern: /ACP connection error: write EPIPE/,
    },
    {
      name: "transient 503 RPC error during active prompt without tool activity is retryable",
      error: new acp.RequestError(-32603, "Internal error", { details: "503 Service Unavailable: model is overloaded" }),
      context: { phase: "active-prompt" },
      expectedOutcome: "retryable",
      expectedRetryableByPi: true,
      expectedPattern: /503 Service Unavailable: model is overloaded/,
    },
    {
      name: "process exit during active prompt is unknown and not retried",
      error: new Error("ACP process closed (1)"),
      context: { phase: "active-prompt" },
      expectedOutcome: "unknown",
      expectedRetryableByPi: false,
      expectedPattern: /ACP process closed \(1\)/,
    },
    {
      name: "transport closure during active prompt is unknown and not retried",
      error: new Error("ACP transport closed"),
      context: { phase: "active-prompt" },
      expectedOutcome: "unknown",
      expectedRetryableByPi: false,
      expectedPattern: /ACP transport closed/,
    },
    {
      name: "timeout during active prompt is unknown and sanitized against Pi retry",
      error: new Error("ACP request timeout: session/prompt"),
      context: { phase: "active-prompt" },
      expectedOutcome: "unknown",
      expectedRetryableByPi: false,
      expectedPattern: /ACP request deadline exceeded: session\/prompt/,
    },
    {
      name: "authentication failure via RequestError -32000 is non-retryable",
      error: new acp.RequestError(-32000, "Authentication required. Run /login to authenticate."),
      context: { phase: "pre-dispatch" },
      expectedOutcome: "non-retryable",
      expectedRetryableByPi: false,
      expectedPattern: /Authentication required/,
    },
    {
      name: "authentication failure wrapped in -32603 Internal error is non-retryable",
      error: new acp.RequestError(-32603, "Internal error", { details: "Authentication required: invalid credentials" }),
      context: { phase: "active-prompt" },
      expectedOutcome: "non-retryable",
      expectedRetryableByPi: false,
      expectedPattern: /agent failure: Authentication required: invalid credentials/,
    },
    {
      name: "quota failure wrapped in -32603 Internal error is non-retryable",
      error: new acp.RequestError(-32603, "Internal error", { details: "Quota exceeded for quota metric" }),
      context: { phase: "active-prompt" },
      expectedOutcome: "non-retryable",
      expectedRetryableByPi: false,
      expectedPattern: /Quota exceeded for quota metric/,
    },
    {
      name: "spawn ENOENT is non-retryable",
      error: Object.assign(new Error("spawn /missing/agy ENOENT"), { code: "ENOENT" }),
      context: { phase: "pre-dispatch" },
      expectedOutcome: "non-retryable",
      expectedRetryableByPi: false,
      expectedPattern: /ENOENT/,
    },
    {
      name: "configuration rejection is non-retryable",
      error: new Error("ACP did not apply the requested model: gemini-3.8-flash"),
      context: { phase: "pre-dispatch" },
      expectedOutcome: "non-retryable",
      expectedRetryableByPi: false,
      expectedPattern: /did not apply the requested model/,
    },
    {
      name: "user cancellation is non-retryable",
      error: new Error("Request aborted by user"),
      context: { phase: "active-prompt", expected: true },
      expectedOutcome: "non-retryable",
      expectedRetryableByPi: false,
      expectedPattern: /Request aborted by user/,
    },
    {
      name: "transient RPC failure with pending MCP tool calls is unknown and not retried",
      error: new acp.RequestError(-32603, "Internal error", { details: "connection lost" }),
      context: { phase: "tool-handoff", hasPendingToolCalls: true },
      expectedOutcome: "unknown",
      expectedRetryableByPi: false,
      expectedPattern: /execution outcome unknown after tool activity; automatic replay disabled/,
    },
    {
      name: "transient failure after completed MCP tool calls is unknown and not retried",
      error: new Error("ACP request timeout: session/prompt"),
      context: { phase: "active-prompt", hasCompletedToolCalls: true },
      expectedOutcome: "unknown",
      expectedRetryableByPi: false,
      expectedPattern: /execution outcome unknown after tool activity; automatic replay disabled/,
    },
    ...["try your request again", "time out", "connection errors", "request timeouts"].map((phrase) => ({
      name: `plural or variant retryable phrase "${phrase}" after tool activity is sanitized and not retried`,
      error: new Error(phrase),
      context: { phase: "active-prompt" as const, hasCompletedToolCalls: true },
      expectedOutcome: "unknown" as const,
      expectedRetryableByPi: false,
      expectedPattern: /execution outcome unknown after tool activity; automatic replay disabled/,
    })),
  ];

  for (const row of cases) {
    test(row.name, () => {
      const outcome = classifyFailure(row.error, row.context);
      const formatted = formatFailureMessage(row.error, row.context);
      const assistantMessage = createAssistantError(formatted.message);

      assert.equal(outcome, row.expectedOutcome);
      assert.equal(formatted.outcome, row.expectedOutcome);
      assert.match(formatted.message, row.expectedPattern);
      assert.equal(
        isRetryableAssistantError(assistantMessage),
        row.expectedRetryableByPi,
        `Expected Pi retryability=${row.expectedRetryableByPi} for message: "${formatted.message}"`,
      );
    });
  }
});
