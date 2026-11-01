import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EventTranslator } from "./events.ts";
import type { RuntimeEvent } from "../types.ts";
import type { AgyEvent } from "../../shared/types.ts";

describe("EventTranslator", () => {
  const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const stepUsage = { input: 2, output: 3, cacheRead: 4, cacheWrite: 0, reasoning: 5, totalTokens: 9, cost: zeroCost };
  const contextUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 9, cost: zeroCost };

  for (const row of [
    {
      name: "no-step result never bills cumulative usage, even when huge",
      events: [{ event: "result", status: "success", conversation_id: "session", usage: { input_tokens: 1_000_000, output_tokens: 2_000_000, cache_read_tokens: 3_000_000, total_tokens: 9_000_000 } }],
      types: ["start", "text-close", "session-reference", "complete"],
      usages: [],
    },
    {
      name: "nested result usage is not a no-step fallback",
      events: [{ event: "result", result: { status: "success", usage: { input_tokens: 1_000_000 } } }],
      types: ["start", "text-close", "complete"],
      usages: [],
    },
    {
      name: "step usage stays normalized and result usage is ignored",
      events: [{ event: "step_update", usage: { input_tokens: 2, output_tokens: 3, cache_read_tokens: 4, thinking_tokens: 5, total_tokens: 999 } }, { event: "result", status: "success", usage: { input_tokens: 99 } }],
      types: ["usage", "start", "text-close", "complete"],
      usages: [stepUsage],
    },
    {
      name: "each step emits its full replacement snapshot, not an aggregate or delta",
      events: [{ event: "step_update", usage: { input_tokens: 2, output_tokens: 3, cache_read_tokens: 4, thinking_tokens: 5 } }, { event: "step_update", usage: { input_tokens: 1 } }, { event: "result", status: "success", usage: { input_tokens: 99 } }],
      types: ["usage", "usage", "start", "text-close", "complete"],
      usages: [stepUsage, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: zeroCost }],
    },
  ] satisfies { name: string; events: AgyEvent[]; types: string[]; usages: Extract<RuntimeEvent, { type: "usage" }>["usage"][] }[]) {
    test(row.name, () => {
      const translator = new EventTranslator();
      const facts: RuntimeEvent[] = [];
      for (const event of row.events) translator.translate(event, "agy", (fact) => facts.push(fact));

      assert.deepEqual(facts.map((fact) => fact.type), row.types);
      assert.deepEqual(facts.filter((fact) => fact.type === "usage").map((fact) => fact.usage), row.usages);
      assert.deepEqual(facts.at(-1), { type: "complete", reason: "stop", resumable: true });
    });
  }

  for (const row of [
    { name: "handoff replays only latest context", before: [], latest: undefined, expected: [contextUsage] },
    { name: "handoff uses the most recent step snapshot", before: [], latest: { input_tokens: 7 }, expected: [{ ...contextUsage, totalTokens: 7 }] },
    { name: "handoff replays an existing zero context snapshot", before: [], latest: { input_tokens: 0 }, expected: [{ ...contextUsage, totalTokens: 0 }] },
    { name: "successful completion clears context", before: [{ event: "result", status: "success" }], expected: [] },
    { name: "error completion clears context", before: [{ event: "result", status: "error", error: "failed" }], expected: [] },
    { name: "aborted completion clears context", before: [{ event: "result", status: "aborted" }], expected: [] },
    { name: "runtime completion clears context", before: [{ event: "result", status: "error", error: "crashed" }], source: "runtime", expected: [] },
    { name: "new user input clears context", before: [{ event: "step_update", update_type: "user_input" }], expected: [] },
  ] as {
    name: string;
    before: AgyEvent[];
    source?: "agy" | "runtime";
    latest?: { input_tokens: number } | undefined;
    expected: Extract<RuntimeEvent, { type: "usage" }>["usage"][];
  }[]) {
    test(row.name, () => {
      const translator = new EventTranslator();
      const facts: RuntimeEvent[] = [];
      const replayed: RuntimeEvent[] = [];
      const duringCompletion: RuntimeEvent[] = [];
      const emit = (fact: RuntimeEvent) => {
        facts.push(fact);
        if (fact.type === "complete") translator.replayContext((context) => duringCompletion.push(context));
      };
      translator.translate({ event: "step_update", usage: { input_tokens: 2, output_tokens: 3, cache_read_tokens: 4, thinking_tokens: 5 } }, "agy", emit);
      if (row.latest) translator.translate({ event: "step_update", usage: row.latest }, "agy", emit);
      for (const event of row.before) translator.translate(event, row.source ?? "agy", emit);
      const factsBeforeReplay = [...facts];

      translator.replayContext((fact) => replayed.push(fact));
      translator.replayContext((fact) => replayed.push(fact));

      assert.deepEqual(replayed, [...row.expected, ...row.expected].map((usage) => ({ type: "usage", usage })));
      assert.deepEqual(facts, factsBeforeReplay);
      assert.deepEqual(duringCompletion, []);

      translator.translate({ event: "step_update", text_delta: "next" }, "agy", emit);
      assert.deepEqual(facts.slice(-2), [{ type: "start" }, { type: "text-delta", delta: "next" }]);
      assert.equal(replayed.length, row.expected.length * 2, "replay must not replace the normal callback");
    });
  }

  test("context replay emits nothing before the first step snapshot", () => {
    const translator = new EventTranslator();
    const facts: RuntimeEvent[] = [];

    translator.replayContext((fact) => facts.push(fact));

    assert.deepEqual(facts, []);
  });

  for (const row of [
    {
      name: "historical completion clears the completed-response flag for the next prompt",
      before: [{ event: "step_update", update_type: "agent_response", state: "DONE" }],
      boundary: { event: "result", status: "error", error: "old" },
      after: [],
      reasons: ["stop", "error"],
    },
    {
      name: "aborted completion clears the completed-response flag",
      before: [{ event: "step_update", update_type: "agent_response", state: "DONE" }],
      boundary: { event: "result", status: "aborted" },
      after: [],
      reasons: ["aborted", "error"],
    },
    {
      name: "aborted completion clears the current-turn error flag but preserves historical error",
      before: [{ event: "step_update", update_type: "error_message" }],
      boundary: { event: "result", status: "aborted" },
      after: [{ event: "step_update", update_type: "agent_response", state: "DONE" }],
      reasons: ["aborted", "stop"],
    },
    {
      name: "runtime completion clears the completed-response flag",
      before: [{ event: "step_update", update_type: "agent_response", state: "DONE" }],
      boundary: { event: "result", status: "error", error: "runtime failure" },
      source: "runtime",
      after: [],
      reasons: ["error", "error"],
    },
    {
      name: "runtime completion clears the current-turn error flag but preserves historical error",
      before: [{ event: "step_update", update_type: "error_message" }],
      boundary: { event: "result", status: "error", error: "runtime failure" },
      source: "runtime",
      after: [{ event: "step_update", update_type: "agent_response", state: "DONE" }],
      reasons: ["error", "stop"],
    },
    {
      name: "user input clears the completed-response flag",
      before: [{ event: "step_update", update_type: "agent_response", state: "DONE" }],
      boundary: { event: "step_update", update_type: "user_input" },
      after: [],
      reasons: ["error"],
    },
    {
      name: "user input clears the current-turn error flag but preserves historical error",
      before: [{ event: "step_update", update_type: "error_message" }],
      boundary: { event: "step_update", update_type: "user_input" },
      after: [{ event: "step_update", update_type: "agent_response", state: "DONE" }],
      reasons: ["stop"],
    },
    {
      name: "a current-turn error is never mistaken for a historical error",
      before: [{ event: "step_update", update_type: "agent_response", state: "DONE" }],
      boundary: { event: "step_update", update_type: "error_message" },
      after: [],
      reasons: ["error"],
    },
  ] as {
    name: string;
    before: AgyEvent[];
    boundary: AgyEvent;
    source?: "agy" | "runtime";
    after: AgyEvent[];
    reasons: Extract<RuntimeEvent, { type: "complete" }>["reason"][];
  }[]) {
    test(row.name, () => {
      const state = { conversationId: "session", lastError: "old" as string | undefined };
      const translator = new EventTranslator({ errorState: state });
      const facts: RuntimeEvent[] = [];
      const emit = (fact: RuntimeEvent) => facts.push(fact);
      translator.translate({ event: "init", conversation_id: "session" }, "agy", emit);
      for (const event of row.before) translator.translate(event, "agy", emit);

      translator.translate(row.boundary, row.source ?? "agy", emit);
      assert.equal(state.lastError, "old", "the boundary must preserve historical error state");
      for (const event of row.after) translator.translate(event, "agy", emit);
      translator.translate({ event: "result", status: "error", error: "old" }, "agy", emit);

      const completions = facts.filter((fact) => fact.type === "complete");
      assert.deepEqual(completions.map((fact) => fact.reason), row.reasons);
      assert.deepEqual(completions.map((fact) => fact.resumable), row.reasons.map((_, index) => !(index === 0 && row.source === "runtime")));
      assert.equal(state.conversationId, "session");
      assert.equal(state.lastError, "old");
    });
  }

  for (const boundary of [
    { event: "step_update", update_type: "user_input" },
    { event: "result", status: "aborted" },
  ] satisfies AgyEvent[]) {
    test(`${boundary.event} preserves the response ID across prompt reset`, () => {
      const state = { conversationId: "session", lastError: "old" as string | undefined };
      const translator = new EventTranslator({ errorState: state });
      const facts: RuntimeEvent[] = [];
      const emit = (fact: RuntimeEvent) => facts.push(fact);
      translator.translate({ event: "init", conversation_id: "session" }, "agy", emit);

      translator.translate(boundary, "agy", emit);
      assert.deepEqual(state, { conversationId: "session", lastError: "old" });
      state.conversationId = "other";
      translator.translate({ event: "result", status: "success" }, "agy", emit);

      assert.equal(state.conversationId, "session", "the translator must retain its response ID");
      assert.equal(state.lastError, undefined);
      assert.deepEqual(facts.at(-1), { type: "complete", reason: "stop", resumable: true });
    });
  }

  test("one translator isolates context across prompts without result-usage fallback", () => {
    const translator = new EventTranslator();
    const facts: RuntimeEvent[] = [];
    const replayed: RuntimeEvent[] = [];
    const emit = (fact: RuntimeEvent) => facts.push(fact);
    const prompts: AgyEvent[][] = [
      [{ event: "step_update", usage: { input_tokens: 2, output_tokens: 3, cache_read_tokens: 4, thinking_tokens: 5 } }],
      [],
      [{ event: "step_update", usage: { output_tokens: 6 } }],
    ];

    for (const events of prompts) {
      translator.translate({ event: "step_update", update_type: "user_input" }, "agy", emit);
      translator.replayContext((fact) => replayed.push(fact));
      for (const event of events) translator.translate(event, "agy", emit);
      translator.replayContext((fact) => replayed.push(fact));
      translator.translate({ event: "result", status: "success", usage: { input_tokens: 1_000_000 } }, "agy", emit);
      translator.replayContext((fact) => replayed.push(fact));
    }

    assert.deepEqual(facts.filter((fact) => fact.type === "usage").map((fact) => fact.usage), [
      stepUsage,
      { input: 0, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: zeroCost },
    ]);
    assert.deepEqual(replayed, [
      { type: "usage", usage: contextUsage },
      { type: "usage", usage: { ...contextUsage, totalTokens: 6 } },
    ]);
    assert.deepEqual(facts.filter((fact) => fact.type === "complete"), prompts.map(() => ({ type: "complete", reason: "stop", resumable: true })));
  });

  {
    test("native policy never emits executable tool facts", () => {
      const translator = new EventTranslator({ allowedToolNames: new Set(["read"]) });
      const facts: RuntimeEvent[] = [];
      translator.translate({ event: "step_update", tool_call: { id: "call", name: "read", arguments: '{"path":"a"}' } }, "agy", (fact) => facts.push(fact));
      assert.equal(facts.length, 0);

      facts.length = 0;
      const blocked = { event: "step_update", tool_call: { name: "write" } };
      translator.translate(blocked, "agy", (fact) => facts.push(fact));
      assert.deepEqual(facts, [{ type: "blocked-native-tool", name: "write" }]);
    });
  }

  for (const source of ["agy", "runtime"] as const) {
    test(`error completion and mutable historical state (${source})`, () => {
      const state = { conversationId: "session", lastError: "old" as string | undefined };
      const translator = new EventTranslator({ errorState: state });
      const facts: RuntimeEvent[] = [];
      translator.translate({ event: "result", status: "error", conversation_id: "session", error: "new" }, source, (fact) => facts.push(fact));
      assert.deepEqual(facts.at(-1), { type: "complete", reason: "error", error: "new", resumable: source === "agy" });
      assert.equal(state.lastError, source === "agy" ? "new" : "old");
    });
  }
});
