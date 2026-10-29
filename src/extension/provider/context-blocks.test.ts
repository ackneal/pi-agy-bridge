import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Context, ImageContent, Message } from "@earendil-works/pi-ai";
import { formatContextBlocks, formatContextPrompt, RESULT_BODY_CEILING } from "./context-prompt.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const image: ImageContent = { type: "image", data: "YWJj", mimeType: "image/png" };
const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage => ({
  role: "assistant", content, stopReason, api: "test", model: "test", provider: "test", usage, timestamp: 1,
});
const call = assistant([{ type: "toolCall", id: "call", name: "read", arguments: { path: "input" } }]);
const result = (content: Extract<Message, { role: "toolResult" }>["content"], isError = false): Message => ({
  role: "toolResult", toolCallId: "call", toolName: "read", content, isError, timestamp: 2,
});
const user = (content: Extract<Message, { role: "user" }>["content"]): Message => ({ role: "user", content, timestamp: 3 });

for (const row of [
  { name: "reconstructed", reused: false, context: { messages: [user("question"), call, result([{ type: "text", text: "done" }]), assistant([{ type: "text", text: "answer" }], "stop"), user("next")] } },
  { name: "incremental", reused: true, context: { messages: [call, result([{ type: "text", text: "done" }]), user("correction")] } },
  { name: "plain user", reused: true, context: { messages: [user("new request")] } },
  { name: "empty", reused: false, context: { messages: [] } },
  { name: "system sections", reused: false, context: { messages: [{ role: "system" as const, content: "base", sections: { policy: "current", removed: null }, timestamp: 0 }, user("question")] } },
  { name: "current result truncation", reused: false, context: { messages: [call, result([{ type: "text", text: "x".repeat(30_000) }], true)] } },
] satisfies { name: string; reused: boolean; context: Context }[]) {
  test(`shared Markdown blocks match CLI exactly: ${row.name}`, () => {
    const blocks = formatContextBlocks(row.context, row.reused, 0);
    assert.ok(blocks.every((block) => block.type === "text"));
    assert.equal(blocks.map((block) => { assert.ok("text" in block); return block.text; }).join("\n\n"), formatContextPrompt(row.context, row.reused, 0));
    assert.ok(blocks.length <= 1);
  });
}

for (const row of [
  { name: "historical user", messages: [user([{ type: "text" as const, text: "image question" }, image]), assistant([{ type: "text" as const, text: "answer" }], "stop"), user("next")], expected: ["> image question", "## Assistant (status: stop)"] },
  { name: "completed tool result", messages: [call, result([{ type: "text" as const, text: "OLD_RESULT_BODY" }, image]), assistant([], "stop"), user("next")], expected: ["> - input", "## User"] },
]) {
  test(`completed history omits native images: ${row.name}`, () => {
    const blocks = formatContextBlocks({ messages: row.messages }, false);
    assert.ok(blocks.every((block) => block.type === "text"));
    const text = blocks.map((block) => block.text).join("\n\n");
    assert.ok(text.includes("[Image omitted from reconstructed history: image/png; content unavailable]"));
    assert.ok(!text.includes("Image attached:"));
    for (const marker of row.expected) assert.ok(text.includes(marker));
    if (row.name === "completed tool result") assert.ok(!text.includes("OLD_RESULT_BODY"));
  });
}

for (const row of [
  { name: "current tool result", messages: [call, result([{ type: "text" as const, text: "current result" }, image]), user("next")], before: "> current result", after: "## User" },
  { name: "truncated error result", messages: [call, result([{ type: "text" as const, text: "x".repeat(30_000) }, image], true), user("next")], before: "status: error", after: "## User" },
]) {
  test(`native image stays with its source in active run: ${row.name}`, () => {
    const blocks = formatContextBlocks({ messages: row.messages }, false);
    const index = blocks.findIndex((block) => block.type === "image");
    assert.ok(index > 0);
    assert.deepEqual(blocks.filter((block) => block.type === "image"), [image]);
    const before = blocks[index - 1]!;
    const after = blocks[index + 1]!;
    assert.ok(before.type === "text" && after.type === "text");
    assert.ok(before.text.includes(row.before));
    assert.ok(before.text.includes("Image attached: image/png"));
    assert.ok(!before.text.includes("content unavailable"));
    assert.ok(after.text.includes(row.after));
    assert.ok(!after.text.includes("Image attached"));
    if (row.name === "truncated error result") {
      assert.ok(before.text.includes("[Truncated:"));
      assert.ok(before.text.length < RESULT_BODY_CEILING + 500);
    }
  });
}

for (const source of ["historical user", "current tool result", "incremental user"] as const) {
  test(`native images preserve interleaved content order: ${source}`, () => {
    const secondImage: ImageContent = { ...image, data: "ZGVm" };
    const content = [{ type: "text" as const, text: "before first" }, image,
      { type: "text" as const, text: "between images" }, secondImage,
      { type: "text" as const, text: "after second" }];
    const messages = source === "current tool result" ? [call, result(content)] : [user(content)];
    const blocks = formatContextBlocks({ messages }, source === "incremental user", 0);
    assert.equal(blocks.length, 5);
    assert.deepEqual(blocks[1], image);
    assert.deepEqual(blocks[3], secondImage);
    for (const [index, label] of [[0, "before first"], [2, "between images"], [4, "after second"]] as const) {
      const block = blocks[index]!;
      assert.ok(block.type === "text" && block.text.includes(`> ${label}`));
      for (const other of ["before first", "between images", "after second"]) {
        if (other !== label) assert.ok(!block.text.includes(`> ${other}`));
      }
    }
  });
}

test("incremental native images remain associated with their message", () => {
  const blocks = formatContextBlocks({ messages: [user([{ type: "text", text: "new image" }, image]), user("later message")] }, true, 0);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[1], image);
  assert.ok(blocks[0]?.type === "text" && blocks[0].text.includes("# Conversation updates\n\n## User\n\n> new image"));
  assert.ok(blocks[2]?.type === "text" && blocks[2].text.includes("## User\n\n> later message"));
});
