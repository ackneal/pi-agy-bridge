import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { formatContextPrompt } from "./provider.ts";

const context = {
  systemPrompt: "Follow <policy> & safety.",
  tools: [],
  messages: [
    {
      role: "user",
      content: "old <question>",
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call-1",
        name: "read",
        arguments: { path: "README.md" },
      }],
      api: "agy",
      provider: "agy",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
      timestamp: 3,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "read complete" }],
      stopReason: "stop",
      timestamp: 4,
    },
    {
      role: "user",
      content: [
        { type: "text", text: "next & now" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
      timestamp: 5,
    },
  ],
} as Context;

describe("formatContextPrompt", () => {
  it("compacts prior tool results and serializes rebuilt context as minified JSON", () => {
    const prompt = formatContextPrompt(context, false);

    assert.equal(prompt.includes("file contents"), false);
    assert.equal(prompt.includes("\n"), false);
    assert.deepEqual(JSON.parse(prompt), {
      purpose: "reconstructed_conversation",
      systemInstructions: "Follow <policy> & safety.",
      history: [
        { role: "user", content: "old <question>" },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
          stopReason: "toolUse",
        },
        { role: "toolResult", toolCallId: "call-1", toolName: "read", isError: false, contentOmitted: true },
        { role: "assistant", content: [{ type: "text", text: "read complete" }], stopReason: "stop" },
      ],
      currentMessage: {
        role: "user",
        content: [
          { type: "text", text: "next & now" },
          { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        ],
      },
    });
  });

  it("omits completed result bodies but preserves their call metadata", () => {
    const prompt = formatContextPrompt({
      messages: [
        { role: "user", content: "old request" },
        { role: "assistant", content: [{ type: "toolCall", id: "old", name: "read", arguments: {} }], stopReason: "toolUse" },
        { role: "toolResult", toolCallId: "old", toolName: "read", content: "old result", isError: false },
        { role: "assistant", content: "old answer", stopReason: "stop" },
        { role: "user", content: "current request" },
        { role: "assistant", content: [{ type: "toolCall", id: "current", name: "read", arguments: {} }], stopReason: "toolUse" },
        { role: "toolResult", toolCallId: "current", toolName: "read", content: "current result", isError: false },
        { role: "user", content: "appended request" },
      ],
    } as Context, false);

    assert.deepEqual(JSON.parse(prompt), {
      purpose: "reconstructed_conversation",
      history: [
        { role: "user", content: "old request" },
        { role: "assistant", content: [{ type: "toolCall", id: "old", name: "read", arguments: {} }], stopReason: "toolUse" },
        { role: "toolResult", toolCallId: "old", toolName: "read", isError: false, contentOmitted: true },
        { role: "assistant", content: "old answer", stopReason: "stop" },
        { role: "user", content: "current request" },
        { role: "assistant", content: [{ type: "toolCall", id: "current", name: "read", arguments: {} }], stopReason: "toolUse" },
        { role: "toolResult", toolCallId: "current", toolName: "read", isError: false, content: "current result" },
      ],
      currentMessage: { role: "user", content: "appended request" },
    });
  });

  it("preserves images and unescaped text in incremental JSON context", () => {
    assert.deepEqual(JSON.parse(formatContextPrompt(context, true, 4)), {
      purpose: "incremental_conversation",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "next & now" },
          { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        ],
      }],
    });
  });
});
