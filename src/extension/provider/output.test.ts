import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
import { PiRuntimeOutput } from "./output.ts";

const call: ToolCall = { type: "toolCall", id: "synthetic-call", name: "read", arguments: { path: "synthetic" } };
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
