import assert from "node:assert/strict";
import { test, describe } from "node:test";
import type { SessionNotification, SessionUpdate, StopReason, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { PromptResponse } from "@agentclientprotocol/sdk/unstable";
import type { RuntimeEvent } from "../types.ts";
import { EventProcessor } from "./events.ts";

const textUpdate: SessionUpdate = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } };
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

describe("EventProcessor notifications and completion", () => {
  for (const sessionUpdate of ["tool_call", "tool_call_update"] as const) {
    for (const kind of ["execute", "edit", "delete", "move"] as const) {
      for (const scope of ["live", "replay", "foreign"] as const) {
        test(`native notification without permission: ${sessionUpdate} ${kind} ${scope}`, () => {
          const facts: RuntimeEvent[] = [];
          const processor = new EventProcessor("session");
          processor.process({
            sessionId: scope === "foreign" ? "other" : "session",
            update: { sessionUpdate, toolCallId: "call", title: "display only", kind, status: "pending" },
          }, scope === "replay" ? "replay" : "live", (fact) => facts.push(fact));
          assert.equal(facts.length, 0, "partial announcements must have a chance to supply identity");
          if (scope === "live") processor.complete({ stopReason: "end_turn" }, (fact) => facts.push(fact));
          assert.deepEqual(facts, scope === "live" ? [{ type: "tool-warning", name: "display only", args: undefined }, { type: "session-reference", reference: "session" }, { type: "complete", reason: "stop", resumable: true }] : []);
        });
      }
    }
  }

  for (const sessionUpdate of ["tool_call", "tool_call_update"] as const) {
    for (const row of [
      { name: "client read", kind: "read", title: "read" },
      { name: "MCP other", kind: "other", title: "pi-agy-bridge_pi_edit", _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "edit" } } },
      { name: "partial announcement", title: "execute" },
      { name: "other without metadata", kind: "other", title: "delete" },
    ] satisfies { name: string; kind?: "read" | "other"; title: string; _meta?: Record<string, unknown> }[]) {
      test(`non-authoritative announcement unchanged: ${sessionUpdate} ${row.name}`, () => {
        const { name: _name, ...call } = row;
        const facts: RuntimeEvent[] = [];
        new EventProcessor("session", new Set(["edit"])).process({
          sessionId: "session", update: sessionUpdate === "tool_call"
            ? { sessionUpdate, toolCallId: "call", status: "pending", ...call }
            : { sessionUpdate, toolCallId: "call", status: "pending", ...call },
        }, "live", (fact) => facts.push(fact));
        assert.deepEqual(facts, []);
      });
    }
  }

  test("native update without title uses kind for display", () => {
    const facts: RuntimeEvent[] = [];
    const processor = new EventProcessor("session");
    processor.process({
      sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: "call", kind: "execute" },
    }, "live", (fact) => facts.push(fact));
    processor.complete({ stopReason: "end_turn" }, (fact) => facts.push(fact));
    assert.deepEqual(facts, [{ type: "tool-warning", name: "execute", args: undefined }, { type: "session-reference", reference: "session" }, { type: "complete", reason: "stop", resumable: true }]);
  });

  for (const row of [
    { name: "text delta", update: textUpdate, source: "live", sessionId: "session", expected: [{ type: "session-reference", reference: "session" }, { type: "text-delta", delta: "hello" }] },
    { name: "empty text delta", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } }, source: "live", sessionId: "session", expected: [{ type: "session-reference", reference: "session" }] },
    { name: "thought chunk ignored", update: { ...textUpdate, sessionUpdate: "agent_thought_chunk" }, source: "live", sessionId: "session", expected: [] },
    { name: "user chunk ignored", update: { ...textUpdate, sessionUpdate: "user_message_chunk" }, source: "live", sessionId: "session", expected: [] },
    { name: "image chunk ignored", update: { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "AA==", mimeType: "image/png" } }, source: "live", sessionId: "session", expected: [] },
    { name: "native tool call ignored", update: { sessionUpdate: "tool_call", toolCallId: "native", title: "read", status: "pending" }, source: "live", sessionId: "session", expected: [] },
    { name: "native tool update ignored", update: { sessionUpdate: "tool_call_update", toolCallId: "native", status: "completed" }, source: "live", sessionId: "session", expected: [] },
    { name: "replay suppressed", update: textUpdate, source: "replay", sessionId: "session", expected: [] },
    { name: "foreign session ignored", update: textUpdate, source: "live", sessionId: "other", expected: [] },
  ] satisfies { name: string; update: SessionUpdate; source: "live" | "replay"; sessionId: string; expected: RuntimeEvent[] }[]) {
    test(`EventProcessor.process: ${row.name}`, () => {
      const processor = new EventProcessor("session");
      const facts: RuntimeEvent[] = [];
      const notification: SessionNotification = { sessionId: row.sessionId, update: row.update };

      processor.process(notification, row.source, (fact) => facts.push(fact));

      assert.deepEqual(facts, row.expected);
    });
  }

  for (const row of [
    { name: "live usage emits used, not capacity", used: 56962, size: 1048576, source: "live", sessionId: "session", expectedUsed: 56962 },
    { name: "zero usage emits a snapshot", used: 0, size: 1048576, source: "live", sessionId: "session", expectedUsed: 0 },
    { name: "finite fractional usage is accepted", used: 0.5, size: 1000, source: "live", sessionId: "session", expectedUsed: 0.5 },
    { name: "capacity does not cap usage", used: 42, size: 1, source: "live", sessionId: "session", expectedUsed: 42 },
    { name: "replay usage suppressed", used: 42, size: 1000, source: "replay", sessionId: "session" },
    { name: "foreign usage ignored", used: 42, size: 1000, source: "live", sessionId: "other" },
    ...[
      { name: "negative", used: -1 },
      { name: "NaN", used: Number.NaN },
      { name: "positive infinity", used: Number.POSITIVE_INFINITY },
      { name: "negative infinity", used: Number.NEGATIVE_INFINITY },
      { name: "missing", used: undefined },
      { name: "null", used: null },
      { name: "string", used: "42" },
    ].map(({ name, used }) => ({ name: `${name} used ignored despite valid capacity`, used, size: 1000, source: "live" as const, sessionId: "session" })),
  ] satisfies { name: string; used: unknown; size: number; source: "live" | "replay"; sessionId: string; expectedUsed?: number }[]) {
    test(`EventProcessor.process usage: ${row.name}`, () => {
      const processor = new EventProcessor("session");
      const facts: RuntimeEvent[] = [];
      // Malformed used values explicitly exercise the notification boundary.
      const update = { sessionUpdate: "usage_update", used: row.used, size: row.size } as SessionUpdate;
      const used = "expectedUsed" in row ? row.expectedUsed : undefined;
      const expected: RuntimeEvent[] = used === undefined ? [] : [
        { type: "usage", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: used, cost: zeroCost } },
      ];

      processor.process({ sessionId: row.sessionId, update }, row.source, (fact) => facts.push(fact));

      assert.deepEqual(facts, expected);
      facts.length = 0;
      processor.complete({ stopReason: "end_turn" }, (fact) => facts.push(fact));
      assert.deepEqual(facts, [...expected, { type: "session-reference", reference: "session" }, { type: "complete", reason: "stop", resumable: true }]);
    });
  }

  for (const scope of ["replay", "foreign"] as const) {
    test(`${scope} usage cannot overwrite the latest live snapshot`, () => {
      const processor = new EventProcessor("session");
      const facts: RuntimeEvent[] = [];
      processor.process({ sessionId: "session", update: { sessionUpdate: "usage_update", used: 42, size: 1000 } }, "live", () => {});
      processor.process({ sessionId: scope === "foreign" ? "other" : "session", update: { sessionUpdate: "usage_update", used: 99, size: 1000 } }, scope === "replay" ? "replay" : "live", (fact) => facts.push(fact));
      assert.equal(facts.length, 0);
      processor.complete({ stopReason: "end_turn" }, (fact) => facts.push(fact));
      assert.deepEqual(facts, [
        { type: "usage", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 42, cost: zeroCost } },
        { type: "session-reference", reference: "session" },
        { type: "complete", reason: "stop", resumable: true },
      ]);
    });
  }

  for (const row of [
    {
      name: "end_turn without usage preserves unavailable semantics",
      response: { stopReason: "end_turn" },
      expected: [{ type: "session-reference", reference: "session" }, { type: "complete", reason: "stop", resumable: true }],
    },
    {
      name: "null usage preserves unavailable semantics",
      response: { stopReason: "end_turn", usage: null },
      expected: [{ type: "session-reference", reference: "session" }, { type: "complete", reason: "stop", resumable: true }],
    },
    {
      name: "empty or invalid usage fields preserve unavailable semantics",
      response: { stopReason: "end_turn", usage: { totalTokens: Number.NaN, inputTokens: -1, outputTokens: Number.POSITIVE_INFINITY } },
      expected: [{ type: "session-reference", reference: "session" }, { type: "complete", reason: "stop", resumable: true }],
    },
    {
      name: "cancelled without usage",
      response: { stopReason: "cancelled" },
      expected: [{ type: "session-reference", reference: "session" }, { type: "complete", reason: "aborted", resumable: false }],
    },
    {
      name: "refusal without usage",
      response: { stopReason: "refusal" },
      expected: [{ type: "session-reference", reference: "session" }, { type: "complete", reason: "error", error: "ACP prompt stopped: refusal", resumable: false }],
    },
    {
      name: "max_tokens without usage",
      response: { stopReason: "max_tokens" },
      expected: [{ type: "session-reference", reference: "session" }, { type: "complete", reason: "error", error: "ACP prompt stopped: max_tokens", resumable: false }],
    },
    {
      name: "max_turn_requests without usage",
      response: { stopReason: "max_turn_requests" },
      expected: [{ type: "session-reference", reference: "session" }, { type: "complete", reason: "error", error: "ACP prompt stopped: max_turn_requests", resumable: false }],
    },
  ] satisfies { name: string; response: PromptResponse; expected: RuntimeEvent[] }[]) {
    test(`EventProcessor.complete: ${row.name}`, () => {
      const processor = new EventProcessor("session");
      const facts: RuntimeEvent[] = [];

      processor.complete(row.response, (fact) => facts.push(fact));

      assert.deepEqual(facts, row.expected);
    });
  }

  for (const row of [
    { name: "response accounting is independent of context 0 -> 56962", snapshots: [0, 56962], stopReason: "end_turn", expected: { type: "complete", reason: "stop", resumable: true } },
    { name: "decreasing snapshots replace rather than accumulate", snapshots: [56962, 4221], stopReason: "end_turn", expected: { type: "complete", reason: "stop", resumable: true } },
    { name: "zero snapshot does not suppress accounting", snapshots: [56962, 0], stopReason: "end_turn", expected: { type: "complete", reason: "stop", resumable: true } },
    { name: "zero-only snapshot does not suppress accounting", snapshots: [0], stopReason: "end_turn", expected: { type: "complete", reason: "stop", resumable: true } },
    { name: "cancelled preserves latest snapshot", snapshots: [0, 56962], stopReason: "cancelled", expected: { type: "complete", reason: "aborted", resumable: false } },
    ...(["refusal", "max_tokens", "max_turn_requests"] as const).map((stopReason) => ({
      name: `${stopReason} preserves latest snapshot`, snapshots: [0, 56962], stopReason,
      expected: { type: "complete" as const, reason: "error" as const, error: `ACP prompt stopped: ${stopReason}`, resumable: false },
    })),
    ...(["end_turn", "cancelled", "refusal", "max_tokens", "max_turn_requests"] as const).map((stopReason) => ({
      name: `${stopReason} accounting without a snapshot still emits`, snapshots: [], stopReason,
      expected: stopReason === "end_turn" ? { type: "complete" as const, reason: "stop" as const, resumable: true }
        : stopReason === "cancelled" ? { type: "complete" as const, reason: "aborted" as const, resumable: false }
          : { type: "complete" as const, reason: "error" as const, error: `ACP prompt stopped: ${stopReason}`, resumable: false },
    })),
  ] satisfies { name: string; snapshots: number[]; stopReason: StopReason; expected: RuntimeEvent }[]) {
    test(`EventProcessor.complete usage: ${row.name}`, () => {
      const processor = new EventProcessor("session");
      const facts: RuntimeEvent[] = [];
      const snapshots: RuntimeEvent[] = [];
      const response: PromptResponse = {
        stopReason: row.stopReason,
        usage: {
          totalTokens: 856715,
          inputTokens: 848726,
          outputTokens: 7989,
          cachedReadTokens: 697052,
          cachedWriteTokens: 0,
          thoughtTokens: 4474,
        },
      };

      for (const used of row.snapshots) {
        processor.process({ sessionId: "session", update: { sessionUpdate: "usage_update", used, size: 1048576 } }, "live", (fact) => facts.push(fact));
        snapshots.push({ type: "usage", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: used, cost: zeroCost } });
        assert.deepEqual(facts, snapshots, "each snapshot must emit immediately without a reasoning breakdown");
      }
      processor.complete(response, (fact) => facts.push(fact));

      const accounting: RuntimeEvent[] = [{ type: "accounting", usage: {
        input: 151674, output: 7989, cacheRead: 697052, cacheWrite: 0,
        reasoning: 4474, totalTokens: 856715, cost: zeroCost,
      } }];
      const latest = snapshots.at(-1);
      assert.deepEqual(facts, [...snapshots, ...(latest ? [latest] : []), ...accounting, { type: "session-reference", reference: "session" }, row.expected]);
    });
  }

  for (const row of [
    {
      name: "thought tokens reported separately are added to output",
      usage: { inputTokens: 3488, outputTokens: 139, thoughtTokens: 594, totalTokens: 4221 },
      expected: { input: 3488, output: 733, cacheRead: 0, cacheWrite: 0, reasoning: 594 },
    },
    {
      name: "output already includes positive thought tokens",
      usage: { inputTokens: 3488, outputTokens: 733, thoughtTokens: 594, totalTokens: 4221 },
      expected: { input: 3488, output: 733, cacheRead: 0, cacheWrite: 0, reasoning: 594 },
    },
    {
      name: "unreconciled total does not prove thoughts are separate",
      usage: { inputTokens: 3488, outputTokens: 733, thoughtTokens: 594, totalTokens: 5000 },
      expected: { input: 3488, output: 733, cacheRead: 0, cacheWrite: 0, reasoning: 594 },
    },
    {
      name: "cache reads and writes are removed from input separately",
      usage: { inputTokens: 100, outputTokens: 10, cachedReadTokens: 30, cachedWriteTokens: 20, totalTokens: 110 },
      expected: { input: 50, output: 10, cacheRead: 30, cacheWrite: 20 },
    },
    {
      name: "cache counts cannot make uncached input negative",
      usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 8, cachedWriteTokens: 9, totalTokens: 12 },
      expected: { input: 0, output: 2, cacheRead: 8, cacheWrite: 9 },
    },
    {
      name: "null optional counts are unavailable",
      usage: { inputTokens: 100, outputTokens: 10, cachedReadTokens: null, cachedWriteTokens: null, thoughtTokens: null, totalTokens: 110 },
      expected: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
    },
    {
      name: "zero input and output are valid accounting",
      usage: { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 },
      expected: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    },
    ...[
      { name: "missing", totalTokens: undefined },
      { name: "null", totalTokens: null },
      { name: "NaN", totalTokens: Number.NaN },
      { name: "infinite", totalTokens: Number.POSITIVE_INFINITY },
      { name: "negative", totalTokens: -1 },
      { name: "string", totalTokens: "4815" },
    ].map(({ name, totalTokens }) => ({
      name: `${name} accounting total cannot prove thoughts are separate`,
      usage: { inputTokens: 3488, outputTokens: 733, thoughtTokens: 594, totalTokens },
      expected: { input: 3488, output: 733, cacheRead: 0, cacheWrite: 0, reasoning: 594 },
    })),
  ] satisfies { name: string; usage: unknown; expected: Omit<Extract<RuntimeEvent, { type: "accounting" }>["usage"], "totalTokens" | "cost"> }[]) {
    test(`EventProcessor.complete accounting: ${row.name}`, () => {
      const processor = new EventProcessor("session");
      const facts: RuntimeEvent[] = [];
      processor.process({ sessionId: "session", update: { sessionUpdate: "usage_update", used: 56962, size: 1048576 } }, "live", () => {});

      // Missing or malformed required totals explicitly test the response boundary.
      processor.complete({ stopReason: "end_turn", usage: row.usage } as PromptResponse, (fact) => facts.push(fact));

      assert.deepEqual(facts.filter((fact) => fact.type === "accounting"), [
        { type: "accounting", usage: { ...row.expected, totalTokens: row.expected.input + row.expected.output + row.expected.cacheRead + row.expected.cacheWrite, cost: zeroCost } },
      ]);
    });
  }

  for (const field of ["inputTokens", "outputTokens"] as const) {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null, "42"]) {
      test(`invalid response ${field}=${String(value)} emits no accounting despite snapshot`, () => {
        const processor = new EventProcessor("session");
        const facts: RuntimeEvent[] = [];
        processor.process({ sessionId: "session", update: { sessionUpdate: "usage_update", used: 42, size: 1000 } }, "live", () => {});
        // Malformed required counts explicitly exercise the response boundary.
        const response = { stopReason: "end_turn", usage: { totalTokens: 110, inputTokens: 100, outputTokens: 10, [field]: value } } as PromptResponse;

        processor.complete(response, (fact) => facts.push(fact));

        assert.deepEqual(facts, [{ type: "usage", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 42, cost: zeroCost } }, { type: "session-reference", reference: "session" }, { type: "complete", reason: "stop", resumable: true }]);
      });
    }
  }

  for (const row of [
    { name: "snapshot only without response usage", usage: undefined },
    { name: "snapshot only with null response usage", usage: null },
  ] satisfies { name: string; usage: PromptResponse["usage"] }[]) {
    test(row.name, () => {
      const processor = new EventProcessor("session");
      const facts: RuntimeEvent[] = [];
      processor.process({ sessionId: "session", update: { sessionUpdate: "usage_update", used: 42, size: 1000 } }, "live", () => {});

      processor.complete(row.usage === undefined ? { stopReason: "end_turn" } : { stopReason: "end_turn", usage: row.usage }, (fact) => facts.push(fact));

      assert.deepEqual(facts, [{ type: "usage", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 42, cost: zeroCost } }, { type: "session-reference", reference: "session" }, { type: "complete", reason: "stop", resumable: true }]);
    });
  }

  for (const used of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null, "42"]) {
    test(`invalid update ${String(used)} does not affect response accounting`, () => {
      const processor = new EventProcessor("session");
      const facts: RuntimeEvent[] = [];
      processor.process({ sessionId: "session", update: { sessionUpdate: "usage_update", used: 42, size: 1000 } }, "live", () => {});
      const update = { sessionUpdate: "usage_update", used, size: 1000 } as SessionUpdate;

      processor.process({ sessionId: "session", update }, "live", (fact) => facts.push(fact));
      assert.equal(facts.length, 0, "invalid update must not emit a snapshot");
      processor.complete({ stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } }, (fact) => facts.push(fact));

      assert.deepEqual(facts, [
        { type: "usage", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 42, cost: zeroCost } },
        { type: "accounting", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: zeroCost } },
        { type: "session-reference", reference: "session" },
        { type: "complete", reason: "stop", resumable: true },
      ]);
    });
  }

  for (const row of [
    { name: "lower response totals", inputs: [100, 50], outputs: [10, 5], contexts: [42, 21] },
    { name: "higher response totals", inputs: [100, 150], outputs: [10, 15], contexts: [42, 63] },
  ]) {
    test(`consecutive prompts account once per response with ${row.name}`, () => {
      const processor = new EventProcessor("session");
      const facts: RuntimeEvent[] = [];
      const expected: RuntimeEvent[] = [];

      for (let prompt = 0; prompt < 2; prompt++) {
        const inputTokens = row.inputs[prompt]!;
        const outputTokens = row.outputs[prompt]!;
        const used = row.contexts[prompt]!;
        const response: PromptResponse = { stopReason: "end_turn", usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } };
        if (prompt === 0) processor.process({ sessionId: "session", update: { sessionUpdate: "usage_update", used, size: 1000 } }, "live", () => {});
        processor.complete(response, (fact) => facts.push(fact));
        expected.push({ type: "accounting", usage: { input: inputTokens, output: outputTokens, cacheRead: 0, cacheWrite: 0, totalTokens: inputTokens + outputTokens, cost: zeroCost } });
        assert.deepEqual(facts.filter((fact) => fact.type === "accounting"), expected);
        assert.deepEqual(facts.filter((fact) => fact.type === "usage"), [{ type: "usage", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: row.contexts[0], cost: zeroCost } }], "only the first prompt has a context snapshot; completion must clear it");
      }
    });
  }

});

describe("EventProcessor tool allowlist validation and warnings", () => {
  const path = "/gemini/antigravity-acp/brain/session/.system_generated/steps/output.txt";
  const mcp = { mcp: { server: "pi-agy-bridge_pi", tool: "read" } };
  const client = {
    toolCallId: "client", title: "Running client_view_file", kind: "read", status: "in_progress",
  } satisfies ToolCallUpdate;
  type Action = { update: ToolCallUpdate; sessionId?: string; replay?: boolean };
  type Case = { name: string; actions: Action[]; warned: boolean };
  const cases: Case[] = [
    { name: "registered Pi MCP identity", actions: [{ update: { toolCallId: "mcp", kind: "other", title: "pi-agy-bridge_pi_read", _meta: mcp } }], warned: false },
    { name: "MCP completion inherits identity", actions: [
      { update: { toolCallId: "mcp", kind: "other", _meta: mcp } },
      { update: { toolCallId: "mcp", status: "completed" } },
    ], warned: false },
    { name: "title first metadata later", actions: [
      { update: { toolCallId: "mcp", kind: "read", title: "display only", status: "pending" } },
      { update: { toolCallId: "mcp", _meta: mcp } },
      { update: { toolCallId: "mcp", status: "completed" } },
    ], warned: false },
    { name: "partial metadata assembles by call ID", actions: [
      { update: { toolCallId: "mcp", _meta: { mcp: { server: "pi-agy-bridge_pi" } } } },
      { update: { toolCallId: "mcp", _meta: { mcp: { tool: "read" } } } },
      { update: { toolCallId: "mcp", _meta: { progress: 1 }, status: "completed" } },
    ], warned: false },
    { name: "foreign MCP server", actions: [{ update: { toolCallId: "mcp", _meta: { mcp: { server: "other", tool: "read" } } } }], warned: true },
    { name: "unregistered Pi tool", actions: [{ update: { toolCallId: "mcp", _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "unknown" } } } }], warned: true },
    { name: "matching title is not MCP identity", actions: [{ update: { toolCallId: "mcp", title: "pi-agy-bridge_pi_read", kind: "other", status: "completed" } }], warned: true },
    { name: "conflicting MCP identity warns once", actions: [
      { update: { toolCallId: "mcp", _meta: mcp } },
      { update: { toolCallId: "mcp", _meta: { mcp: { tool: "other" } } } },
      { update: { toolCallId: "mcp", _meta: mcp } },
    ], warned: true },
    ...(["read", "search", "execute", "edit", "delete", "move", "other"] as const).map((kind): Case => ({
      name: `unverified ${kind} activity`, actions: [{ update: { toolCallId: "native", kind, status: "completed" } }], warned: true,
    })),
    { name: "unclassified named activity at prompt end", actions: [{ update: { toolCallId: "native", title: "unknown operation", status: "in_progress" } }], warned: true },
    { name: "client announcement without callback or raw input", actions: [{ update: client }], warned: false },
    ...[
      { title: "running client_view_file", warned: false },
      { title: "RUNNING CLIENT_VIEW_FILE", warned: false },
      { title: "rUnNiNg ClIeNt_ViEw_FiLe", warned: false },
      { title: " \tRunning client_view_file\n", warned: false },
      { title: " \tRUNNING CLIENT_VIEW_FILE\n", warned: false },
      { title: "Running not_client_view_file", warned: true },
      { title: "Running client_view_file_extra", warned: true },
      { title: "Other Running client_view_file", warned: true },
      { title: "client_view_file", warned: true },
      { title: "Running  client_view_file", warned: true },
    ].map(({ title, warned }): Case => ({
      name: `client title ${JSON.stringify(title)}`, actions: [{ update: { ...client, title } }], warned,
    })),
    { name: "normalized client title with wrong kind warns", actions: [{ update: { ...client, title: " RUNNING CLIENT_VIEW_FILE ", kind: "other" } }], warned: true },
    { name: "normalized client title with foreign MCP warns", actions: [{ update: { ...client, title: " RUNNING CLIENT_VIEW_FILE ", _meta: { mcp: { server: "other", tool: "read" } } } }], warned: true },
    ...(["completed", "failed"] as const).map((status): Case => ({
      name: `client ${status} without callback`, actions: [{ update: client }, { update: { toolCallId: "client", status } }], warned: false,
    })),
    { name: "client path changes do not warn", actions: [
      { update: { ...client, rawInput: { absolute_path: path } } },
      { update: { toolCallId: "client", rawInput: { absolute_path: "/other" }, status: "completed" } },
    ], warned: false },
    { name: "native view_file is not client_view_file", actions: [{ update: { ...client, title: "Running view_file" } }], warned: true },
    { name: "client then registered MCP is trusted without identity conflict", actions: [
      { update: client }, { update: { toolCallId: "client", _meta: mcp } },
    ], warned: false },
    { name: "client with foreign MCP warns", actions: [{ update: { ...client, _meta: { mcp: { server: "other", tool: "read" } } } }], warned: true },
    { name: "client with unregistered MCP warns", actions: [{ update: { ...client, _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "unknown" } } } }], warned: true },
    { name: "client title with wrong kind warns", actions: [{ update: { ...client, kind: "other" } }], warned: true },
    { name: "client title without kind warns", actions: [{ update: { toolCallId: "client", title: client.title } }], warned: true },
    { name: "identity cannot transfer across tool IDs", actions: [{ update: { toolCallId: "mcp", _meta: mcp } }, { update: { toolCallId: "other", title: "read", status: "completed" } }], warned: true },
    { name: "registered lazy Pi MCP tool", actions: [
      { update: { toolCallId: "lazy", title: "call_mcp_tool", rawInput: { ServerName: "pi-agy-bridge_pi", ToolName: "read", Arguments: { path } }, status: "completed" } },
    ], warned: false },
    { name: "running lazy Pi MCP tool title", actions: [
      { update: { toolCallId: "lazy", title: "Running call_mcp_tool", rawInput: { ServerName: "pi-agy-bridge_pi", ToolName: "read" }, status: "completed" } },
    ], warned: false },
    { name: "lazy Pi MCP partial updates assemble by call ID", actions: [
      { update: { toolCallId: "lazy", title: "Running call_mcp_tool", status: "in_progress" } },
      { update: { toolCallId: "lazy", rawInput: { ServerName: "pi-agy-bridge_pi", ToolName: "read" }, status: "completed" } },
    ], warned: false },
    { name: "lazy MCP foreign server", actions: [
      { update: { toolCallId: "lazy", title: "call_mcp_tool", rawInput: { ServerName: "other", ToolName: "read" }, status: "completed" } },
    ], warned: true },
    { name: "lazy MCP unregistered Pi tool", actions: [
      { update: { toolCallId: "lazy", title: "call_mcp_tool", rawInput: { ServerName: "pi-agy-bridge_pi", ToolName: "unknown" }, status: "completed" } },
    ], warned: true },
    { name: "lazy MCP missing ToolName at completion", actions: [
      { update: { toolCallId: "lazy", title: "call_mcp_tool", rawInput: { ServerName: "pi-agy-bridge_pi" }, status: "completed" } },
    ], warned: true },
    { name: "replay does not populate allowlist", actions: [{ update: { toolCallId: "mcp", _meta: mcp }, replay: true }, { update: { toolCallId: "mcp", kind: "other", status: "completed" } }], warned: true },
    { name: "foreign session does not populate allowlist", actions: [{ update: { toolCallId: "mcp", _meta: mcp }, sessionId: "other" }, { update: { toolCallId: "mcp", kind: "other", status: "completed" } }], warned: true },
    { name: "status-only orphan update is not an identifiable tool", actions: [{ update: { toolCallId: "orphan", status: "completed" } }], warned: false },
  ];

  for (const row of cases) {
    test(`tool allowlist: ${row.name}`, () => {
      const processor = new EventProcessor("session", new Set(["read"]));
      const events: RuntimeEvent[] = [];

      for (const action of row.actions) {
        processor.process({ sessionId: action.sessionId ?? "session", update: { ...action.update, sessionUpdate: "tool_call_update" } },
          action.replay ? "replay" : "live", (event) => events.push(event));
      }
      processor.complete({ stopReason: "end_turn" }, (event) => events.push(event));

      assert.equal(events.filter((event) => event.type === "tool-warning").length, row.warned ? 1 : 0);
      assert.deepEqual(events.filter((event) => event.type === "complete"), [{ type: "complete", reason: "stop", resumable: true }]);
      if (row.warned) {
        const count = events.length;
        processor.process({ sessionId: "session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } } }, "live", (event) => events.push(event));
        processor.complete({ stopReason: "end_turn" }, (event) => events.push(event));
        assert.equal(events.length, count + 4, "warnings must not suppress later text or success");
      }
    });
  }

  for (const replacement of [null, "", []]) {
    test(`malformed MCP metadata cannot erase prior identity: ${JSON.stringify(replacement)}`, () => {
      const processor = new EventProcessor("session", new Set(["read", "write"]));
      const events: RuntimeEvent[] = [];
      for (const identity of [mcp, { mcp: replacement }, { mcp: { server: "pi-agy-bridge_pi", tool: "write" } }]) {
        processor.process({ sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: "same", _meta: identity } },
          "live", (event) => events.push(event));
      }
      processor.complete({ stopReason: "end_turn" }, (event) => events.push(event));
      assert.equal(events.filter((event) => event.type === "tool-warning").length, 1);
      assert.equal(events.find((event) => event.type === "tool-warning")?.name, "write");
      assert.deepEqual(events.filter((event) => event.type === "complete"), [{ type: "complete", reason: "stop", resumable: true }]);
    });
  }

  for (const row of [
    { name: "native canonical name and raw args", call: { toolCallId: "same", title: "Running view_file", rawInput: { absolute_path: path }, status: "completed" }, expectedName: "view_file", args: { absolute_path: path } },
    { name: "MCP tool and unwrapped args", call: { toolCallId: "same", _meta: { mcp: { server: "other", tool: "read" } }, rawInput: { arguments: { path } } }, expectedName: "read", args: { path } },
    { name: "lazy MCP tool and unwrapped args", call: { toolCallId: "same", title: "Running call_mcp_tool", rawInput: { ServerName: "other", ToolName: "read", Arguments: { path } }, status: "completed" }, expectedName: "read", args: { path } },
  ] satisfies { name: string; call: ToolCallUpdate; expectedName: string; args: unknown }[]) {
    test(`warning facts: ${row.name}`, () => {
      const processor = new EventProcessor("session", new Set(["read"]));
      const events: RuntimeEvent[] = [];
      const emit = (event: RuntimeEvent) => events.push(event);
      for (let prompt = 0; prompt < 2; prompt++) {
        processor.process({ sessionId: "session", update: { ...row.call, sessionUpdate: "tool_call_update" } }, "live", emit);
        for (const identity of [mcp, { mcp: { server: "other", tool: "changed" } }, mcp]) {
          processor.process({ sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: "same", _meta: identity } }, "live", emit);
        }
        processor.complete({ stopReason: "end_turn" }, emit);
      }
      assert.deepEqual(events.filter((event) => event.type === "tool-warning"), Array.from({ length: 2 }, () => ({ type: "tool-warning", name: row.expectedName, args: row.args })));
      assert.equal(events.filter((event) => event.type === "complete").length, 2);
    });
  }

  test("bounded notification tracking warns once on overflow per prompt without suppressing output", () => {
    const processor = new EventProcessor("session", new Set(["read"]));
    const events: RuntimeEvent[] = [];
    const emit = (event: RuntimeEvent) => events.push(event);
    for (let prompt = 0; prompt < 2; prompt++) {
      for (let id = 0; id < 1030; id++) {
        processor.process({ sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: String(id), _meta: mcp } }, "live", emit);
      }
      processor.process({ sessionId: "session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "continued" } } }, "live", emit);
      processor.complete({ stopReason: "end_turn" }, emit);
    }
    assert.deepEqual(events.filter((event) => event.type === "tool-warning"), Array.from({ length: 2 }, () => ({ type: "tool-warning", name: "ACP tool notification limit exceeded", args: undefined })));
    assert.equal(events.filter((event) => event.type === "text-delta").length, 2);
    assert.equal(events.filter((event) => event.type === "complete").length, 2);
  });
});
