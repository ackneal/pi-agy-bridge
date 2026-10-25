import assert from "node:assert/strict";
import { test } from "node:test";
import { CliEventTranslator } from "./events.ts";
import type { RuntimeEvent } from "../types.ts";
import type { AgyEvent } from "../../shared/types.ts";

for (const row of [
  {
    name: "result boundaries precede normalized accounting and reference",
    events: [{ event: "result", status: "success", conversation_id: "session", usage: { input_tokens: 2, output_tokens: 3, cache_read_tokens: 4, total_tokens: 5 } }],
    types: ["start", "text-close", "usage", "session-reference", "complete"],
  },
  {
    name: "step usage wins over result usage",
    events: [{ event: "step_update", usage: { input_tokens: 2, output_tokens: 3, cache_read_tokens: 4 } }, { event: "result", status: "success", usage: { input_tokens: 99 } }],
    types: ["usage", "start", "text-close", "complete"],
  },
] satisfies { name: string; events: AgyEvent[]; types: string[] }[]) {
  test(row.name, () => {
    const translator = new CliEventTranslator();
    const facts: RuntimeEvent[] = [];
    for (const event of row.events) translator.translate(event, "agy", (fact) => facts.push(fact));
    assert.deepEqual(facts.map((fact) => fact.type), row.types);
    const usage = facts.find((fact) => fact.type === "usage");
    assert.equal(usage?.usage.totalTokens, 9);
    assert.equal(usage?.usage.cacheRead, 4);
    assert.deepEqual(facts.at(-1), { type: "complete", reason: "stop", resumable: true });
  });
}

{
  test("native policy never emits executable tool facts", () => {
    const translator = new CliEventTranslator({ allowedToolNames: new Set(["read"]) });
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
    const translator = new CliEventTranslator({ errorState: state });
    const facts: RuntimeEvent[] = [];
    translator.translate({ event: "result", status: "error", conversation_id: "session", error: "new" }, source, (fact) => facts.push(fact));
    assert.deepEqual(facts.at(-1), { type: "complete", reason: "error", error: "new", resumable: source === "agy" });
    assert.equal(state.lastError, source === "agy" ? "new" : "old");
  });
}
