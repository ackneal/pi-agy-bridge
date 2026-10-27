import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionNotification, SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
import type { RuntimeEvent } from "../types.ts";
import { EventProcessor } from "./events.ts";

const textUpdate: SessionUpdate = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } };

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
  {
    name: "usage update normalized",
    update: { sessionUpdate: "usage_update", used: 42, size: 1000 },
    source: "live",
    sessionId: "session",
    expected: [{
      type: "usage",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 42, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }],
  },
  { name: "replay usage suppressed", update: { sessionUpdate: "usage_update", used: 42, size: 1000 }, source: "replay", sessionId: "session", expected: [] },
] satisfies { name: string; update: SessionUpdate; source: "live" | "replay"; sessionId: string; expected: RuntimeEvent[] }[]) {
  test(`process notification: ${row.name}`, () => {
    const processor = new EventProcessor("session");
    const facts: RuntimeEvent[] = [];
    const notification: SessionNotification = { sessionId: row.sessionId, update: row.update };

    processor.process(notification, row.source, (fact) => facts.push(fact));

    assert.deepEqual(facts, row.expected);
  });
}

for (const row of [
  { reason: "end_turn", expected: { type: "complete", reason: "stop", resumable: true } },
  { reason: "cancelled", expected: { type: "complete", reason: "aborted", resumable: false } },
  { reason: "refusal", expected: { type: "complete", reason: "error", error: "ACP prompt stopped: refusal", resumable: false } },
  { reason: "max_tokens", expected: { type: "complete", reason: "error", error: "ACP prompt stopped: max_tokens", resumable: false } },
  { reason: "max_turn_requests", expected: { type: "complete", reason: "error", error: "ACP prompt stopped: max_turn_requests", resumable: false } },
] satisfies { reason: StopReason; expected: RuntimeEvent }[]) {
  test(`complete prompt: ${row.reason}`, () => {
    const processor = new EventProcessor("session");
    const facts: RuntimeEvent[] = [];

    processor.complete({ stopReason: row.reason }, (fact) => facts.push(fact));

    assert.deepEqual(facts, [{ type: "session-reference", reference: "session" }, row.expected]);
  });
}
