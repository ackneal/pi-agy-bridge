import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { formatContextPrompt } from "./provider.ts";

const assistant: AssistantMessage = {
  role: "assistant",
  content: [{ type: "toolCall", id: "call<&1", name: "read", namespace: "files&docs", arguments: { path: "a<b" } }],
  api: "openai-responses",
  provider: "openai",
  model: "test",
  usage: {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "error",
  errorMessage: 'failed <read> & "retry"',
  timestamp: 2,
};

const { errorMessage: omittedError, ...assistantWithoutError } = assistant;

interface Case {
  name: string;
  context: Context;
  includes?: string[];
  excludes?: string[];
}

const cases: Case[] = [
  ...[true, false].map((isError): Case => ({
    name: `reconstructs tool IDs, namespace, assistant metadata and is_error=${isError}`,
    context: { messages: [assistant, {
      role: "toolResult", toolCallId: "call<&1", toolName: "read",
      content: [{ type: "text", text: "result & details" }], isError, timestamp: 3,
    }, { role: "user", content: "continue", timestamp: 4 }] },
    includes: [
      '<message role="assistant" stop_reason="error" error_message="failed &lt;read&gt; &amp; &quot;retry&quot;">',
      '<tool_call id="call&lt;&amp;1" name="read" namespace="files&amp;docs">',
      '<arguments>{&quot;path&quot;:&quot;a&lt;b&quot;}</arguments>',
      `<tool_result call_id="call&lt;&amp;1" tool_name="read" is_error="${isError}">`,
      '<text>result &amp; details</text>',
    ],
  })),
  {
    name: "omits optional namespace and error metadata when absent",
    context: { messages: [{ ...assistantWithoutError, stopReason: "toolUse",
      content: [{ type: "toolCall", id: "plain", name: "read", arguments: {} }],
    }, { role: "user", content: "continue", timestamp: 3 }] },
    includes: ['<message role="assistant" stop_reason="toolUse">', '<tool_call id="plain" name="read">'],
    excludes: ["namespace=", "error_message="],
  },
];

describe("formatContextPrompt provider semantics", () => {
  for (const { name, context, includes = [], excludes = [] } of cases) {
    it(name, () => {
      const prompt = formatContextPrompt(context, false);

      for (const fragment of includes) assert.ok(prompt.includes(fragment), `Missing ${fragment} in ${prompt}`);
      for (const fragment of excludes) assert.ok(!prompt.includes(fragment), `Unexpected ${fragment} in ${prompt}`);
    });
  }
});
