import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { RuntimeEvent } from "../drivers/types.ts";
import { EventProcessor } from "../drivers/acp/events.ts";
import { PiRuntimeOutput } from "./output.ts";

const call: ToolCall = { type: "toolCall", id: "synthetic-call", name: "read", arguments: { path: "synthetic" } };
const thinkingCases: {
  name: string;
  events: RuntimeEvent[];
  bridge?: boolean;
  reason: "stop" | "toolUse" | "error" | "aborted";
  lifecycle: string[];
}[] = [
  { name: "text-close closes thinking before a new block", events: [
    { type: "thinking-delta", delta: "a" }, { type: "text-close" },
    { type: "thinking-delta", delta: "b" }, { type: "complete", reason: "stop", resumable: true },
  ], reason: "stop", lifecycle: ["start", "thinking_start", "thinking_delta", "thinking_end", "thinking_start", "thinking_delta", "thinking_end", "done"] },
  { name: "bridge handoff closes thinking before tools", events: [{ type: "thinking-delta", delta: "a" }], bridge: true, reason: "toolUse",
    lifecycle: ["start", "thinking_start", "thinking_delta", "thinking_end", "toolcall_start", "toolcall_delta", "toolcall_end", "done"] },
  ...(["error", "aborted"] as const).map((reason) => ({
    name: `${reason} closes thinking`, events: [
      { type: "thinking-delta" as const, delta: "a" },
      { type: "complete" as const, reason, error: "failure", resumable: false },
    ], reason, lifecycle: ["start", "thinking_start", "thinking_delta", "thinking_end", "error"],
  })),
  { name: "blocked native tool closes thinking", events: [
    { type: "thinking-delta", delta: "a" }, { type: "blocked-native-tool", name: "write" },
  ], reason: "error", lifecycle: ["start", "thinking_start", "thinking_delta", "thinking_end", "error"] },
];

for (const row of thinkingCases) {
  test(`native thinking output: ${row.name}`, async () => {
    const output = new PiRuntimeOutput({ model: "model" });

    for (const event of row.events) output.handleRuntimeEvent(event);
    if (row.bridge) output.handleBridgeToolCalls([call]);
    const final = output.message;
    output.handleRuntimeEvent({ type: "thinking-delta", delta: "late" });
    output.handleRuntimeEvent({ type: "text-delta", delta: "late" });
    output.handleRuntimeEvent({ type: "text-close" });
    output.handleTermination("aborted", "late");
    const events: AssistantMessageEvent[] = [];
    for await (const event of output.stream) events.push(event);

    assert.deepEqual(events.map((event) => event.type), row.lifecycle);
    assert.deepEqual(output.message, final);
    assert.equal(final.content[0]?.type, "thinking");
    if (final.content[0]?.type === "thinking") assert.equal(final.content[0].thinking, "a");
    assert.equal(final.stopReason, row.reason);
  });
}

const acpThinkingCases: {
  name: string;
  updates: SessionNotification["update"][];
  content: PiRuntimeOutput["message"]["content"];
  lifecycle: string[];
}[] = [
  { name: "thought chunks concatenate and alternate with visible text", updates: [
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "a" } },
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "b" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "c" } },
  ], content: [{ type: "thinking", thinking: "ab" }, { type: "text", text: "answer" }, { type: "thinking", thinking: "c" }],
    lifecycle: ["start", "thinking_start", "thinking_delta", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "thinking_start", "thinking_delta", "thinking_end", "done"] },
  { name: "empty thought chunks emit no thinking block", updates: [
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "" } },
  ], content: [], lifecycle: ["start", "done"] },
];

for (const row of acpThinkingCases) {
  test(`ACP processor through Pi output: ${row.name}`, async () => {
    const processor = new EventProcessor("session");
    const output = new PiRuntimeOutput({ model: "model" });
    const emit = (event: RuntimeEvent) => output.handleRuntimeEvent(event);
    const ignored: SessionNotification = { sessionId: "session", update: {
      sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "ignored" },
    } };

    processor.process(ignored, "replay", emit);
    processor.process({ ...ignored, sessionId: "other" }, "live", emit);
    for (const update of row.updates) processor.process({ sessionId: "session", update }, "live", emit);
    processor.complete({ stopReason: "end_turn" }, emit);
    processor.process(ignored, "live", emit);
    const events: AssistantMessageEvent[] = [];
    for await (const event of output.stream) events.push(event);

    assert.deepEqual(events.map((event) => event.type), row.lifecycle);
    assert.deepEqual(output.message.content, row.content);
    assert.equal(output.message.responseId, "session");
    assert.equal(output.message.stopReason, "stop");
  });
}

const cases: {
  name: string;
  act: (output: PiRuntimeOutput) => void;
  reason: string;
  tools: number;
  blocked: string[];
}[] = [
  { name: "normalized text completion", act: (output) => {
    output.handleRuntimeEvent({ type: "session-reference", reference: "synthetic-session" });
    output.handleRuntimeEvent({ type: "text-delta", delta: "synthetic answer" });
    output.handleRuntimeEvent({ type: "complete", reason: "stop", resumable: true });
  }, reason: "stop", tools: 0, blocked: [] },
  { name: "native facts cannot execute tools", act: (output) => {
    output.handleRuntimeEvent({ type: "blocked-native-tool", name: call.name });
  }, reason: "error", tools: 0, blocked: ["read"] },
  { name: "shared bridge owns executable tool handoff", act: (output) => {
    output.handleBridgeToolCalls([call]);
  }, reason: "toolUse", tools: 1, blocked: [] },
  { name: "blocked batch appends no calls", act: (output) => {
    output.handleBridgeToolCalls([call, { ...call, id: "unavailable", name: "write" }]);
  }, reason: "error", tools: 0, blocked: ["write"] },
];

for (const row of cases) {
  test(`shared runtime output: ${row.name}`, async () => {
    const blocked: string[] = [];
    const output = new PiRuntimeOutput({
      model: "synthetic-model", allowedToolNames: new Set(["read"]),
      onBlockedTool: (name) => { blocked.push(name); },
    });

    row.act(output);
    const final = output.message;
    output.handleRuntimeEvent({ type: "session-reference", reference: "late-session" });
    output.handleRuntimeEvent({ type: "blocked-native-tool", name: "late-blocked" });
    output.handleBridgeToolCalls([call]);
    const events: AssistantMessageEvent[] = [];
    for await (const event of output.stream) events.push(event);

    assert.equal(final.stopReason, row.reason);
    assert.equal(final.content.filter((block) => block.type === "toolCall").length, row.tools);
    assert.deepEqual(blocked, row.blocked);
    assert.deepEqual(output.message, final);
    assert.equal(events.filter((event) => event.type === "done" || event.type === "error").length, 1);
    if (row.name === "normalized text completion") {
      assert.equal(final.responseId, "synthetic-session");
      assert.deepEqual(final.content, [{ type: "text", text: "synthetic answer" }]);
    }
  });
}
