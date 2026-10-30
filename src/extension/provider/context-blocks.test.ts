import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Context, ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { formatContextBlocks, formatContextPrompt } from "./context-prompt.ts";

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
    assert.ok(blocks.length <= 2);
  });
}

for (const row of [
  { name: "historical user", messages: [user([{ type: "text" as const, text: "image question" }, image]), assistant([{ type: "text" as const, text: "answer" }], "stop"), user("next")], expected: ["[User]: image question", "[Assistant]: answer", "next"] },
  { name: "completed tool result", messages: [call, result([{ type: "text" as const, text: "OLD_RESULT_BODY" }, image]), assistant([], "stop"), user("next")], expected: ["- read(path=\"input\")", "next"] },
]) {
  test(`completed history omits native images: ${row.name}`, () => {
    const blocks = formatContextBlocks({ messages: row.messages }, false);
    assert.ok(blocks.every((block) => block.type === "text"));
    const text = blocks.map((block) => block.text).join("\n\n");
    assert.ok(!text.includes("OLD_RESULT_BODY"));
    assert.ok(!text.includes("image/png"));
    for (const marker of row.expected) assert.ok(text.includes(marker));
  });
}

for (const row of [
  { name: "current user with image", messages: [call, assistant([], "stop"), user([{ type: "text" as const, text: "current prompt" }, image])], historyMarker: "- read(path=\"input\")", promptMarker: "current prompt" },
]) {
  test(`native image separates into image block in active run: ${row.name}`, () => {
    const blocks = formatContextBlocks({ messages: row.messages }, false);
    assert.equal(blocks.length, 3);
    assert.deepEqual(blocks[2], image);
    const historyBlock = blocks[0]!;
    const promptBlock = blocks[1]!;
    assert.ok(historyBlock.type === "text" && promptBlock.type === "text");
    assert.ok(historyBlock.text.includes(row.historyMarker));
    assert.ok(promptBlock.text.includes(row.promptMarker));
  });
}

test("current user prompt with interleaved images preserves order", () => {
  const secondImage: ImageContent = { ...image, data: "ZGVm" };
  const content = [{ type: "text" as const, text: "before first" }, image,
    { type: "text" as const, text: "between images" }, secondImage,
    { type: "text" as const, text: "after second" }];
  const messages = [user(content)];
  const blocks = formatContextBlocks({ messages }, false, 0);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[1], image);
  assert.deepEqual(blocks[2], secondImage);
  assert.ok(blocks[0]?.type === "text" && blocks[0].text.includes("before first\n\nbetween images\n\nafter second"));
});

test("incremental user with image delivers single text block and image blocks", () => {
  const content = [{ type: "text" as const, text: "幫我看看這張圖 ./xxx/xxx.png" }, image];
  const blocks = formatContextBlocks({ messages: [user(content)] }, true, 0);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: "text", text: "幫我看看這張圖 ./xxx/xxx.png" });
  assert.deepEqual(blocks[1], image);
});

test("incremental user sequence merges texts and appends image blocks", () => {
  const secondImage: ImageContent = { ...image, data: "ZGVm" };
  const messages = [
    user([{ type: "text", text: "幫我看看這張圖 ./xxx/xxx.png" }, image]),
    user([{ type: "text", text: "還有這張 ./xxx/yyy.png" }, secondImage]),
  ];
  const blocks = formatContextBlocks({ messages }, true, 0);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0], { type: "text", text: "幫我看看這張圖 ./xxx/xxx.png\n\n還有這張 ./xxx/yyy.png" });
  assert.deepEqual(blocks[1], image);
  assert.deepEqual(blocks[2], secondImage);
});

test("assistant message with mixed text and toolCall serializes correctly in history", () => {
  const mixedAssistant = assistant([
    { type: "text", text: "executing command" },
    { type: "toolCall", id: "call_42", name: "bash", arguments: { command: "echo test" } },
  ]);
  const blocks = formatContextBlocks({ messages: [mixedAssistant] }, false);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0]?.type === "text");
  assert.ok(blocks[0].text.includes("[Assistant]: executing command"));
  assert.ok(blocks[0].text.includes("[Assistant tool calls]:\n- bash(command=\"echo test\")"));
});

