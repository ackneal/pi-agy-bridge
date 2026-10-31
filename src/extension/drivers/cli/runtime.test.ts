import assert from "node:assert/strict";
import test from "node:test";
import { AgyRuntime } from "../../runtime/process.ts";
import type { RuntimeEvent } from "../types.ts";
import type { ConversationErrorState } from "./events.ts";
import { RuntimeSession } from "./runtime.ts";

for (const row of [
  { name: "replacement in the same conversation ignores historical error", preserve: true, conversationId: "same", reason: "stop" },
  { name: "new conversation reports the same error", preserve: true, conversationId: "new", reason: "error" },
  { name: "fresh runtime history reports the same error", preserve: false, conversationId: "same", reason: "error" },
] as const) {
  test(row.name, (t) => {
    let listener: Parameters<AgyRuntime["onEvent"]>[0] | undefined;
    t.mock.method(AgyRuntime.prototype, "onEvent", (handler: Parameters<AgyRuntime["onEvent"]>[0]) => {
      listener = handler;
      return () => { listener = undefined; };
    });
    const state: ConversationErrorState = { conversationId: "same" };
    const first = new RuntimeSession({ agentName: "pi-bridge", model: "test" }, new Set(), state);
    const facts: RuntimeEvent[] = [];
    const unsubscribe = first.onRuntimeEvent((event) => facts.push(event));
    assert.ok(listener);
    listener({ event: "result", status: "error", conversation_id: "same", error: "quota" }, "agy");
    assert.deepEqual(facts.at(-1), { type: "complete", reason: "error", error: "quota", resumable: true });
    unsubscribe();

    const replacement = new RuntimeSession(
      { agentName: "pi-bridge", model: "test", conversationId: row.conversationId },
      new Set(), row.preserve ? state : { conversationId: row.conversationId },
    );
    const stop = replacement.onRuntimeEvent((event) => facts.push(event));
    try {
      assert.ok(replacement instanceof AgyRuntime);
      assert.ok(listener);
      listener({ event: "step_update", update_type: "agent_response", state: "DONE" }, "agy");
      listener({ event: "result", status: "error", conversation_id: row.conversationId, error: "quota" }, "agy");
      assert.deepEqual(facts.at(-1), row.reason === "error"
        ? { type: "complete", reason: "error", error: "quota", resumable: true }
        : { type: "complete", reason: "stop", resumable: true });
    } finally {
      stop();
    }
  });
}
