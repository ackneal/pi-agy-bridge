import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgyBridge, formatContextPrompt } from "./provider.ts";

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

for (const scenario of [
  { name: "legacy enabled", marker: "1", apiKey: undefined, enabled: true, epoch: undefined },
  { name: "missing credential", marker: undefined, apiKey: undefined, enabled: false, epoch: undefined },
  { name: "disabled marker", marker: "0", apiKey: undefined, enabled: false, epoch: undefined },
  { name: "OAuth setup marker", marker: undefined, apiKey: "agy-bridge:test-epoch", enabled: true, epoch: "test-epoch" },
  { name: "invalid OAuth marker", marker: undefined, apiKey: "agy-bridge:", enabled: false, epoch: undefined },
]) {
  it(`stream gate with unknown auth status: ${scenario.name}`, async (t) => {
    let provider: Provider | undefined;
    const bridge = new AgyBridge({
      on: () => {}, registerCommand: () => {}, getActiveTools: () => [], getAllTools: () => [],
      registerProvider: (registered: Provider) => { provider = registered; },
    } as unknown as ExtensionAPI);
    t.after(() => bridge.liveSessions.disposeAll());
    const lookup = t.mock.method(bridge.runtimeSessionStore, "get", async () => {
      throw new Error("Reached runtime using existing AGY login");
    });
    bridge.start();
    assert.ok(provider);

    for (const stream of [provider.stream, provider.streamSimple]) {
      assert.ok(stream);
      const message = await stream({ id: "test", provider: "agy" } as Model<any>,
        normalizeContext({ messages: [], tools: [] }), {
          sessionId: "gate-test",
          env: scenario.marker === undefined ? {} : { AGY_BRIDGE_ENABLED: scenario.marker },
          ...(scenario.apiKey ? { apiKey: scenario.apiKey } : {}),
        }).result();

      assert.equal(message.stopReason, "error");
      assert.equal(message.errorMessage, scenario.enabled
        ? "Reached runtime using existing AGY login"
        : "Antigravity CLI disabled in Pi");
    }
    assert.equal(lookup.mock.callCount(), scenario.enabled ? 2 : 0);
    if (scenario.enabled) {
      for (const call of lookup.mock.calls) assert.equal(call.arguments[1], scenario.epoch);
    }
  });
}
