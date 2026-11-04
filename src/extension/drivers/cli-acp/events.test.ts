import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EventProcessor } from "./events.ts";
import type { RuntimeEvent } from "../types.ts";

describe("EventProcessor", () => {
  test("emits text-delta on agent_message_chunk", () => {
    const processor = new EventProcessor("session-123", new Set(["read"]));
    const events: RuntimeEvent[] = [];
    const emit = (e: RuntimeEvent) => events.push(e);

    processor.process(
      {
        sessionId: "session-123",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello world" },
        },
      } as any,
      "live",
      emit
    );

    assert.deepEqual(events, [
      { type: "session-reference", reference: "session-123" },
      { type: "text-delta", delta: "Hello world" },
    ]);
  });

  test("ignores notifications from other sessions or replay", () => {
    const processor = new EventProcessor("session-123");
    const events: RuntimeEvent[] = [];
    const emit = (e: RuntimeEvent) => events.push(e);

    processor.process(
      {
        sessionId: "other-session",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Ignore" } },
      } as any,
      "live",
      emit
    );

    processor.process(
      {
        sessionId: "session-123",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Ignore" } },
      } as any,
      "replay",
      emit
    );

    assert.equal(events.length, 0);
  });

  test("emits usage on usage_update", () => {
    const processor = new EventProcessor("session-123");
    const events: RuntimeEvent[] = [];
    const emit = (e: RuntimeEvent) => events.push(e);

    processor.process(
      {
        sessionId: "session-123",
        update: { sessionUpdate: "usage_update", used: 150 },
      } as any,
      "live",
      emit
    );

    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "usage");
    if (events[0]?.type === "usage") {
      assert.equal(events[0].usage.totalTokens, 150);
    }
  });

  test("warns on unallowed native tools and permits view_file and allowed MCP tools", () => {
    const processor = new EventProcessor("session-123", new Set(["read", "bash"]));
    const events: RuntimeEvent[] = [];
    const emit = (e: RuntimeEvent) => events.push(e);

    // Allowed native tool (view_file)
    processor.process(
      {
        sessionId: "session-123",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "view_file",
          status: "completed",
        },
      } as any,
      "live",
      emit
    );

    // Allowed MCP tool
    processor.process(
      {
        sessionId: "session-123",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-2",
          title: "read",
          _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "read" } },
          status: "completed",
        },
      } as any,
      "live",
      emit
    );

    // Unallowed native tool (e.g. edit_file)
    processor.process(
      {
        sessionId: "session-123",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-3",
          title: "edit_file",
          rawInput: { file: "foo.txt" },
          status: "completed",
        },
      } as any,
      "live",
      emit
    );

    const warnings = events.filter((e) => e.type === "tool-warning");
    assert.equal(warnings.length, 1);
    if (warnings[0]?.type === "tool-warning") {
      assert.equal(warnings[0].name, "edit_file");
    }
  });

  test("complete emits accounting and completion reason", () => {
    const processor = new EventProcessor("session-123");
    const events: RuntimeEvent[] = [];
    const emit = (e: RuntimeEvent) => events.push(e);

    processor.complete(
      {
        stopReason: "end_turn",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cachedReadTokens: 20,
          cachedWriteTokens: 0,
          thoughtTokens: 10,
          totalTokens: 160,
        },
      } as any,
      emit
    );

    const accounting = events.find((e) => e.type === "accounting");
    assert.ok(accounting);
    if (accounting?.type === "accounting") {
      assert.equal(accounting.usage.input, 80);
      assert.equal(accounting.usage.output, 60);
      assert.equal(accounting.usage.cacheRead, 20);
    }

    const complete = events.find((e) => e.type === "complete");
    assert.ok(complete);
    if (complete?.type === "complete") {
      assert.equal(complete.reason, "stop");
      assert.equal(complete.resumable, true);
    }
  });
});
