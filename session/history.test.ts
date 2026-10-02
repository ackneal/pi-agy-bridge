import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgyProcess } from "../runtime/process.ts";
import { serializeHistoryMessage } from "./history.ts";
import { RuntimeSessionSync } from "./session-state.ts";
import { LiveSession } from "./session.ts";

const assistant = { role: "assistant", content: [{ type: "text", text: "answer" }], stopReason: "stop" };
const toolCall = { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } };
const toolResult = { role: "toolResult", toolCallId: "call-1", toolName: "read", content: "result", isError: false };
const system = { role: "system", content: "instructions", sections: { first: "one", second: "two" } };
const tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };

describe("serializeHistoryMessage", () => {
  const cases = [
    ...[
      { thinkingLevel: "high" },
      { usage: { input: 1, output: 2, totalTokens: 3 } },
      { timestamp: 123 },
    ].map((metadata) => ({ name: `ignores ${Object.keys(metadata)[0]}`, before: assistant, after: { ...assistant, ...metadata }, equal: true })),
    { name: "detects user text", before: { role: "user", content: "one" }, after: { role: "user", content: "two" }, equal: false },
    { name: "detects assistant text", before: assistant, after: { ...assistant, content: [{ type: "text", text: "changed" }] }, equal: false },
    { name: "detects call ID", before: { ...assistant, content: [toolCall] }, after: { ...assistant, content: [{ ...toolCall, id: "call-2" }] }, equal: false },
    { name: "detects call arguments", before: { ...assistant, content: [toolCall] }, after: { ...assistant, content: [{ ...toolCall, arguments: { path: "b" } }] }, equal: false },
    { name: "detects tool-result error", before: toolResult, after: { ...toolResult, isError: true }, equal: false },
    { name: "detects system section order", before: system, after: { ...system, sections: { second: "two", first: "one" } }, equal: false },
    { name: "detects added tool declarations", before: system, after: { ...system, toolsAdded: [tool] }, equal: false },
    { name: "detects changed tool declarations", before: { ...system, toolsAdded: [tool] }, after: { ...system, toolsAdded: [{ ...tool, description: "Changed" }] }, equal: false },
    { name: "detects removed tools", before: system, after: { ...system, toolsRemoved: ["read"] }, equal: false },
  ];

  for (const { name, before, after, equal } of cases) {
    it(name, () => {
      const original = serializeHistoryMessage(before);
      const updated = serializeHistoryMessage(after);

      if (equal) assert.equal(updated, original);
      else assert.notEqual(updated, original);
    });
  }

  const invalidCases = [
    { name: "unknown role", message: { role: "custom", content: "text" }, error: /Unsupported Pi history role: custom/ },
    { name: "unknown block", message: { role: "assistant", content: [{ type: "audio" }] }, error: /Unsupported Pi history content block: audio/ },
    { name: "non-object block", message: { role: "user", content: [null] }, error: /Unsupported Pi history content block/ },
  ];

  for (const { name, message, error } of invalidCases) {
    it(`rejects ${name}`, () => {
      assert.throws(() => serializeHistoryMessage(message), error);
    });
  }
});

describe("RuntimeSessionSync history regression", () => {
  for (const { name, response, action } of [
    { name: "continues after metadata addition", response: { ...assistant, thinkingLevel: "high", usage: { input: 1, output: 2 }, timestamp: 123 }, action: "continue" },
    { name: "rebuilds after semantic change", response: { ...assistant, content: [{ type: "text", text: "changed" }] }, action: "rebuild" },
  ]) {
    it(name, () => {
      const live = new LiveSession("pi-session-history");
      live.setSession({ isRunning: true } as AgyProcess, "sync-key", undefined, "conversation");
      const sync = new RuntimeSessionSync();
      const history = [{ role: "user", content: "question" }];
      sync.record(live, history, assistant);

      const decision = sync.decide(live, {
        syncKey: "sync-key", turnIndex: 0, conversationId: "conversation",
        canonicalHistory: [...history, response, { role: "user", content: "next" }],
      });

      assert.deepEqual(decision, { action });
    });
  }
});
