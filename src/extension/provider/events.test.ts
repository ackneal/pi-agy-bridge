import { beforeEach } from "node:test";
import { useAuthHomeFixture } from "./auth-home-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { PiEventWriter } from "./events.ts";

useAuthHomeFixture();

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
