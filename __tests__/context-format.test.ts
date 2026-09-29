import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { formatContextPrompt } from "../provider.ts";

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
      role: "user",
      content: [
        { type: "text", text: "next & now" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
      timestamp: 4,
    },
  ],
} as Context;

describe("formatContextPrompt", () => {
  it("formats rebuild context as escaped XML with history and current message", () => {
    assert.equal(formatContextPrompt(context, false), `<pi_context purpose="reconstructed_conversation">
  <system_instructions>Follow &lt;policy&gt; &amp; safety.</system_instructions>
  <history>
    <message role="user">
      <text>old &lt;question&gt;</text>
    </message>
    <message role="assistant">
      <tool_call id="call-1" name="read">
        <arguments>{&quot;path&quot;:&quot;README.md&quot;}</arguments>
      </tool_call>
    </message>
    <tool_result call_id="call-1" tool_name="read" is_error="false">
      <text>file contents</text>
    </tool_result>
  </history>
  <current_message role="user">
    <text>next &amp; now</text>
    <image mime_type="image/png">binary content omitted</image>
  </current_message>
</pi_context>`);
  });

  it("sends only the latest message when continuing or resuming", () => {
    assert.equal(formatContextPrompt(context, true), "next & now\n[Image: image/png]");
  });
});
