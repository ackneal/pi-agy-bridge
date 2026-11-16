import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, isContextOverflow } from "@earendil-works/pi-ai";
import { calculateContextTokens, SessionManager } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent } from "../drivers/types.ts";
import { EventProcessor } from "../drivers/acp/events.ts";
import { PiEventWriter } from "./events.ts";

const tool: ToolCall = { type: "toolCall", id: "call-1", name: "read", arguments: { path: "file" } };

const cases: {
  name: string;
  act: (writer: PiEventWriter) => void;
  types: AssistantMessageEvent["type"][];
  reason: "stop" | "toolUse" | "error" | "aborted";
  text?: string;
}[] = [
  { name: "empty completion starts before done", act: (w) => w.finish(), types: ["start", "done"], reason: "stop" },
  { name: "text deltas share a block and close before done", act: (w) => { w.appendTextDelta("a"); w.appendTextDelta("b"); w.finish(); }, types: ["start", "text_start", "text_delta", "text_delta", "text_end", "done"], reason: "stop", text: "ab" },
  { name: "tools close text and later text opens a new block", act: (w) => { w.appendTextDelta("a"); w.appendToolCall(tool); w.appendTextDelta("b"); w.finish(); }, types: ["start", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_end", "text_start", "text_delta", "text_end", "done"], reason: "toolUse", text: "ab" },
  { name: "bridge handoff emits complete tool lifecycle", act: (w) => { w.appendToolCall(tool); w.finish("toolUse"); }, types: ["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"], reason: "toolUse" },
  ...(["error", "aborted"] as const).map((reason) => ({ name: `${reason} closes active text before error`, act: (w: PiEventWriter) => { w.appendTextDelta("a"); w.handleTermination(reason, "failure"); }, types: ["start", "text_start", "text_delta", "text_end", "error"] as AssistantMessageEvent["type"][], reason, text: "a" })),
];

for (const row of cases) {
  test(row.name, async () => {
    const stream = createAssistantMessageEventStream();
    const writer = new PiEventWriter({ model: "model", provider: "provider", stream });
    writer.setModel("selected");
    writer.setResponseId("session");

    row.act(writer);
    writer.finish();
    writer.handleTermination("error", "late");
    writer.appendTextDelta("late");
    writer.appendToolCall(tool);

    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) events.push(event);

    assert.equal(writer.stream, stream);
    assert.deepEqual(events.map((event) => event.type), row.types);
    assert.equal(writer.isCompleted(), true);
    assert.equal(writer.message.stopReason, row.reason);
    assert.equal(writer.message.model, "selected");
    assert.equal(writer.message.provider, "provider");
    assert.equal(writer.message.responseId, "session");
    assert.equal(writer.message.content.filter((block) => block.type === "text").map((block) => block.text).join(""), row.text ?? "");
    assert.throws(() => writer.setModel("late"), /Cannot change model/);
    for (const event of events) {
      if (event.type === "toolcall_delta") assert.equal(event.delta, JSON.stringify(tool.arguments));
      if (event.type === "toolcall_end") assert.deepEqual(event.toolCall, tool);
      if (event.type === "error") assert.equal(event.error.errorMessage, "failure");
    }
    const start = events[0];
    assert.equal(start?.type, "start");
    if (start?.type === "start") assert.deepEqual(start.partial.content, []);
  });
}

for (const stage of ["before-start", "after-text-close"] as const) {
  test(`normalized usage and isolated snapshots: ${stage}`, async () => {
    const writer = new PiEventWriter({ model: "model" });
    const usage = { ...writer.message.usage, input: 11, output: 5, cacheRead: 7, totalTokens: 23 };

    if (stage === "after-text-close") {
      writer.appendTextDelta("text");
      writer.closeActiveText();
    }
    writer.setUsage(usage);
    writer.finish();
    const events: AssistantMessageEvent[] = [];
    for await (const event of writer.stream) events.push(event);
    const snapshot = writer.message;
    snapshot.usage.input = 999;
    snapshot.usage.cost.total = 999;
    snapshot.content.length = 0;

    assert.deepEqual(writer.message.usage, usage);
    const end = events.at(-1);
    assert.equal(end?.type, "done");
    if (end?.type === "done") assert.deepEqual(end.message.usage, usage);
    const textEnd = events.find((event) => event.type === "text_end");
    if (stage === "after-text-close") {
      assert.equal(textEnd?.partial.usage.input, 0);
      assert.deepEqual(writer.message.content, [{ type: "text", text: "text" }]);
    }
  });
}

const thinkingCases: {
  name: string;
  act: (writer: PiEventWriter) => void;
  lifecycle: string[];
  content: PiEventWriter["message"]["content"];
}[] = [
  { name: "thinking deltas share a block", act: (w) => { w.appendThinkingDelta("a"); w.appendThinkingDelta("b"); w.finish(); },
    lifecycle: ["start", "thinking_start:0", "thinking_delta:0", "thinking_delta:0", "thinking_end:0", "done"],
    content: [{ type: "thinking", thinking: "ab" }] },
  { name: "alternating kinds close before opening the next block", act: (w) => { w.appendThinkingDelta("a"); w.appendTextDelta("b"); w.appendThinkingDelta("c"); w.finish(); },
    lifecycle: ["start", "thinking_start:0", "thinking_delta:0", "thinking_end:0", "text_start:1", "text_delta:1", "text_end:1", "thinking_start:2", "thinking_delta:2", "thinking_end:2", "done"],
    content: [{ type: "thinking", thinking: "a" }, { type: "text", text: "b" }, { type: "thinking", thinking: "c" }] },
  { name: "tool call closes thinking", act: (w) => { w.appendThinkingDelta("a"); w.appendToolCall(tool); w.finish(); },
    lifecycle: ["start", "thinking_start:0", "thinking_delta:0", "thinking_end:0", "toolcall_start:1", "toolcall_delta:1", "toolcall_end:1", "done"],
    content: [{ type: "thinking", thinking: "a" }, tool] },
  { name: "text-close boundary splits thinking blocks", act: (w) => { w.appendThinkingDelta("a"); w.closeActiveText(); w.closeActiveText(); w.appendThinkingDelta("b"); w.finish(); },
    lifecycle: ["start", "thinking_start:0", "thinking_delta:0", "thinking_end:0", "thinking_start:1", "thinking_delta:1", "thinking_end:1", "done"],
    content: [{ type: "thinking", thinking: "a" }, { type: "thinking", thinking: "b" }] },
  { name: "empty thinking does not create blocks or interrupt text", act: (w) => { w.appendThinkingDelta(""); w.appendTextDelta("a"); w.appendThinkingDelta(""); w.appendTextDelta("b"); w.finish(); },
    lifecycle: ["start", "text_start:0", "text_delta:0", "text_delta:0", "text_end:0", "done"],
    content: [{ type: "text", text: "ab" }] },
  { name: "empty thinking alone emits no block", act: (w) => { w.appendThinkingDelta(""); w.finish(); },
    lifecycle: ["start", "done"], content: [] },
  ...(["error", "aborted"] as const).map((reason) => ({
    name: `${reason} closes thinking`, act: (w: PiEventWriter) => { w.appendThinkingDelta("a"); w.handleTermination(reason, "failure"); },
    lifecycle: ["start", "thinking_start:0", "thinking_delta:0", "thinking_end:0", "error"],
    content: [{ type: "thinking" as const, thinking: "a" }],
  })),
];

for (const row of thinkingCases) {
  test(`native thinking writer: ${row.name}`, async () => {
    const writer = new PiEventWriter({ model: "model" });

    row.act(writer);
    const final = writer.message;
    writer.appendThinkingDelta("late");
    writer.appendTextDelta("late");
    writer.closeActiveText();
    writer.appendToolCall(tool);
    writer.finish();
    writer.handleTermination("error", "late");
    const events: AssistantMessageEvent[] = [];
    for await (const event of writer.stream) events.push(event);

    assert.deepEqual(events.map((event) => "contentIndex" in event ? `${event.type}:${event.contentIndex}` : event.type), row.lifecycle);
    assert.deepEqual(final.content, row.content);
    assert.deepEqual(writer.message, final);
    const accumulated: PiEventWriter["message"]["content"] = [];
    for (const event of events) {
      if (event.type === "text_start") accumulated.push({ type: "text", text: "" });
      if (event.type === "thinking_start") accumulated.push({ type: "thinking", thinking: "" });
      if (event.type === "toolcall_start") accumulated.push(tool);
      if (event.type === "text_delta" || event.type === "thinking_delta") {
        const block = accumulated[event.contentIndex]!;
        if (block.type === "text") block.text += event.delta;
        if (block.type === "thinking") block.thinking += event.delta;
      }
      if (event.type === "text_end" || event.type === "thinking_end") {
        const block = accumulated[event.contentIndex]!;
        assert.equal(event.content, block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : undefined);
      }
      const snapshot = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
      assert.deepEqual(snapshot.content, accumulated, `${event.type} snapshot reflects only content emitted so far`);
    }
    const thinking = final.content.find((block) => block.type === "thinking");
    if (thinking) thinking.thinking = "mutated snapshot";
    assert.deepEqual(writer.message.content, row.content);
  });
}

const accountingUsage = {
  inputTokens: 848726, outputTokens: 7989, cachedReadTokens: 697052,
  thoughtTokens: 4474, totalTokens: 856715,
};

for (const row of [
  { name: "accounting and context stay independent", used: [0, 56962], raw: accountingUsage, input: 151674, output: 7989, cacheRead: 697052, context: 56962 },
  { name: "zero context retains billable accounting", used: [56962, 0], raw: accountingUsage, input: 151674, output: 7989, cacheRead: 697052, context: 0 },
  { name: "missing context retains billable accounting", used: [], raw: accountingUsage, input: 151674, output: 7989, cacheRead: 697052, context: 0 },
  { name: "real cumulative usage above 1M does not overflow context", used: [164101], raw: {
    inputTokens: 1376305, cachedReadTokens: 1267257, outputTokens: 15092,
    thoughtTokens: 7137, totalTokens: 1391397,
  }, input: 109048, output: 15092, cacheRead: 1267257, context: 164101 },
  { name: "separately reported thoughts count once in accounting output", used: [123], raw: {
    inputTokens: 848726, outputTokens: 7989, cachedReadTokens: 697052,
    thoughtTokens: 4474, totalTokens: 861189,
  }, input: 151674, output: 12463, cacheRead: 697052, context: 123 },
]) {
  test(`ACP usage through Pi writer: ${row.name}`, async () => {
    const processor = new EventProcessor("session");
    const manager = SessionManager.inMemory();
    let writer = new PiEventWriter({ model: "model" });
    const intermediate = writer;
    const emit = (event: RuntimeEvent) => {
      if (event.type === "usage") writer.setUsage(event.usage);
      if (event.type === "accounting") manager.appendUsage("agy_turn", "agy", "model", event.usage);
    };
    const assertContext = (message: typeof writer.message, context: number) => {
      assert.deepEqual([message.usage.input, message.usage.output, message.usage.cacheRead, message.usage.cacheWrite], [0, 0, 0, 0]);
      assert.equal(calculateContextTokens(message.usage), context);
      assert.equal(isContextOverflow(message, 1048576), false);
    };

    writer.appendTextDelta("before tool");
    for (const used of row.used) {
      processor.process({ sessionId: "session", update: { sessionUpdate: "usage_update", used, size: 1048576 } }, "live", emit);
      assertContext(writer.message, used);
      assert.equal(manager.getEntries().length, 0, "snapshots must not create accounting entries");
    }
    writer.appendToolCall(tool);
    writer.finish("toolUse");
    manager.appendMessage(writer.message);
    assertContext(writer.message, row.context);
    assert.equal(manager.getEntries().filter((entry) => entry.type === "usage").length, 0, "tool handoff must not bill the prompt");

    writer = new PiEventWriter({ model: "model" });
    writer.appendTextDelta("after tool");
    processor.complete({ stopReason: "end_turn", usage: row.raw }, emit);
    writer.finish();
    manager.appendMessage(writer.message);

    assertContext(writer.message, row.context);
    for (const source of [intermediate, writer]) {
      for await (const event of source.stream) {
        const message = "partial" in event ? event.partial : event.type === "done" ? event.message : undefined;
        if (message) {
          assert.deepEqual([message.usage.input, message.usage.output, message.usage.cacheRead, message.usage.cacheWrite], [0, 0, 0, 0], "stream snapshots must never contain billable components");
          assert.equal(isContextOverflow(message, 1048576), false);
        }
      }
    }

    const entries = manager.getEntries().filter((entry) => entry.type === "usage");
    assert.equal(entries.length, 1, "one accounting entry per ACP prompt, independent of Pi messages");
    const entry = entries[0]!;
    assert.equal(entry.kind, "agy_turn");
    assert.equal(entry.provider, "agy");
    assert.equal(entry.model, "model");
    assert.deepEqual(entry.usage, {
      input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: 0,
      reasoning: row.raw.thoughtTokens,
      totalTokens: row.input + row.output + row.cacheRead,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });
}
