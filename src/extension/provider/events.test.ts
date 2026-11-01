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
    const footerTotals = entries.reduce((totals, { usage }) => ({
      input: totals.input + usage.input,
      output: totals.output + usage.output,
      cacheRead: totals.cacheRead + usage.cacheRead,
      cacheWrite: totals.cacheWrite + usage.cacheWrite,
    }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(footerTotals, { input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: 0 });
  });
}
