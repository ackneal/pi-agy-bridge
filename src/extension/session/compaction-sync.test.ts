import assert from "node:assert/strict";
import test from "node:test";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { LiveSession, PiContextAdapter } from "./session.ts";
import { RuntimeSessionStore, RuntimeSessionSync } from "./state.ts";
import type { RuntimeSessionSyncInput } from "./state.ts";

type Scenario = {
  name: string;
  resumed: boolean;
  compact: boolean;
  expected: "rebuild" | "continue";
};

const scenarios: Scenario[] = [
  { name: "live runtime after compaction", resumed: false, compact: true, expected: "rebuild" },
  { name: "persisted checkpoint after compaction", resumed: true, compact: true, expected: "rebuild" },
  { name: "cancellation without compaction", resumed: false, compact: false, expected: "continue" },
];

test("RuntimeSessionSync follows Pi's projected compaction context", async (t) => {
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const manager = SessionManager.inMemory("/workspace");
      manager.appendMessage({ role: "user", content: "old question", timestamp: 1 });
      const kept = manager.appendMessage({ role: "user", content: "recent question", timestamp: 2 });
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "old answer" }], api: "test", provider: "test", model: "test", responseId: "historical-agy-session", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
      const preCompactionMessages = convertToLlm(manager.buildSessionContext().messages);
      if (scenario.compact) manager.appendCompaction("Earlier conversation summarized", kept, 100);
      const context = manager.buildSessionContext();
      assert.equal(context.messages.some((message) => message.role === "user" && message.content === "old question"), !scenario.compact);
      assert.ok(convertToLlm(context.messages).some((message) =>
        message.role === "assistant" && message.responseId === "historical-agy-session"));
      const pi = new PiContextAdapter();
      const id = pi.bind(manager);
      const store = new RuntimeSessionStore(pi);
      const session = new LiveSession(id);
      session.setSession({ driver: "cli", isRunning: true, onRuntimeEvent: () => () => {}, formatContextUpdate: () => "", submit: async () => {}, abort: async () => {} }, "key", undefined, "historical-agy-session");
      const sync = new RuntimeSessionSync();
      if (!scenario.resumed) sync.record(session, preCompactionMessages);
      const checkpoint = scenario.resumed ? await store.set(id, { sessionId: "historical-agy-session" }, preCompactionMessages, undefined, "cli:v1") : undefined;
      const input: RuntimeSessionSyncInput = { syncKey: "key", conversationId: "historical-agy-session", messages: convertToLlm(context.messages), ...(checkpoint ? { checkpoint } : {}) };
      const decision = sync.decide(session, input);
      assert.equal(decision.action, scenario.expected);
    });
  }
});
