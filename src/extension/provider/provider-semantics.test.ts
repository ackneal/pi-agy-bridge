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
  isReused: boolean;
  expected: unknown;
}

const formattedAssistant = {
  role: "assistant",
  content: [{ type: "toolCall", id: "call<&1", name: "read", namespace: "files&docs", arguments: { path: "a<b" } }],
  stopReason: "error",
  errorMessage: 'failed <read> & "retry"',
};

const cases: Case[] = [
  ...[true, false].flatMap((isReused) => [true, false].map((isError): Case => ({
    name: `${isReused ? "increments" : "reconstructs"} tool IDs, namespace, assistant metadata and isError=${isError}`,
    context: { messages: [{ role: "user", content: "read", timestamp: 1 }, assistant, {
      role: "toolResult", toolCallId: "call<&1", toolName: "read",
      content: [{ type: "text", text: "result & details" }], isError, timestamp: 3,
    }] },
    isReused,
    expected: isReused ? {
      purpose: "incremental_conversation",
      messages: [
        { role: "user", content: "read" }, formattedAssistant,
        { role: "toolResult", content: [{ type: "text", text: "result & details" }], toolCallId: "call<&1", toolName: "read", isError },
      ],
    } : {
      purpose: "reconstructed_conversation",
      history: [{ role: "user", content: "read" }, formattedAssistant],
      currentMessage: { role: "toolResult", content: [{ type: "text", text: "result & details" }], toolCallId: "call<&1", toolName: "read", isError },
    },
  }))),
  ...[true, false].map((isReused): Case => ({
    name: `omits absent namespace and error metadata in ${isReused ? "incremental" : "rebuilt"} JSON`,
    context: { messages: [{ ...assistantWithoutError, stopReason: "toolUse",
      content: [{ type: "toolCall", id: "plain", name: "read", arguments: {} }],
    }, { role: "user", content: "continue", timestamp: 3 }] },
    isReused,
    expected: isReused ? {
      purpose: "incremental_conversation",
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "plain", name: "read", arguments: {} }], stopReason: "toolUse" },
        { role: "user", content: "continue" },
      ],
    } : {
      purpose: "reconstructed_conversation",
      history: [{ role: "assistant", content: [{ type: "toolCall", id: "plain", name: "read", arguments: {} }], stopReason: "toolUse" }],
      currentMessage: { role: "user", content: "continue" },
    },
  })),
  ...[true, false].flatMap((isReused) => [
    { name: "mixed section updates", sections: { policy: "<policy> & safety", removed: null },
      expectedSections: { policy: "<policy> & safety", removed: null } },
    { name: "removal-only sections", sections: { removed: null }, expectedSections: { removed: null } },
    { name: "empty sections", sections: {}, expectedSections: undefined },
  ].map(({ name, sections, expectedSections }): Case => ({
    name: `${expectedSections ? "preserves" : "omits"} ${name} in ${isReused ? "incremental" : "rebuilt"} JSON`,
    context: { messages: [{ role: "system", content: "rules <&>", sections, timestamp: 1 }] },
    isReused,
    expected: isReused ? {
      purpose: "incremental_conversation",
      messages: [{ role: "system", content: "rules <&>", ...(expectedSections ? { sections: expectedSections } : {}) }],
    } : {
      purpose: "reconstructed_conversation", history: [],
      currentMessage: { role: "system", content: "rules <&>", ...(expectedSections ? { sections: expectedSections } : {}) },
    },
  }))),
  ...[true, false].map((isReused): Case => ({
    name: `preserves section replacement and removal order in ${isReused ? "incremental" : "rebuilt"} JSON`,
    context: { messages: [
      { role: "system", content: "", sections: { policy: "old policy", retained: "keep" }, timestamp: 1 },
      { role: "system", content: "", sections: { policy: "new policy" }, timestamp: 2 },
      { role: "system", content: "", sections: { policy: null }, timestamp: 3 },
      { role: "user", content: "continue", timestamp: 4 },
    ] },
    isReused,
    expected: isReused ? {
      purpose: "incremental_conversation",
      messages: [
        { role: "system", content: "", sections: { policy: "old policy", retained: "keep" } },
        { role: "system", content: "", sections: { policy: "new policy" } },
        { role: "system", content: "", sections: { policy: null } },
        { role: "user", content: "continue" },
      ],
    } : {
      purpose: "reconstructed_conversation",
      history: [
        { role: "system", content: "", sections: { policy: "old policy", retained: "keep" } },
        { role: "system", content: "", sections: { policy: "new policy" } },
        { role: "system", content: "", sections: { policy: null } },
      ],
      currentMessage: { role: "user", content: "continue" },
    },
  })),
];

describe("formatContextPrompt provider semantics", () => {
  for (const { name, context, isReused, expected } of cases) {
    it(name, () => {
      const prompt = formatContextPrompt(context, isReused, 0);

      assert.deepEqual(JSON.parse(prompt), expected);
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
      throw new Error("Reached runtime using existing Antigravity CLI login");
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
        ? "Reached runtime using existing Antigravity CLI login"
        : "Antigravity CLI disabled in Pi");
    }
    assert.equal(lookup.mock.callCount(), scenario.enabled ? 2 : 0);
    if (scenario.enabled) {
      for (const call of lookup.mock.calls) assert.equal(call.arguments[1], scenario.epoch);
    }
  });
}
