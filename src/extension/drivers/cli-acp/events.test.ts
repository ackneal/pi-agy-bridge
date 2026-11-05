import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionNotification, ToolCallUpdate } from "@agentclientprotocol/sdk";
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
      },
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
      },
      "live",
      emit
    );

    processor.process(
      {
        sessionId: "session-123",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Ignore" } },
      },
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
        update: { sessionUpdate: "usage_update", used: 150, size: 1000 },
      },
      "live",
      emit
    );

    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "usage");
    if (events[0]?.type === "usage") {
      assert.equal(events[0].usage.totalTokens, 150);
    }
  });

  const toolCases: { name: string; call: Omit<ToolCallUpdate, "toolCallId">; warning?: string }[] = [
    ...["view_file", "Running view_file", " \tRUNNING VIEW_FILE\n"].map((title) => ({ name: title, call: { title } })),
    ...["not_view_file", "view_file_extra", "Running view_file_extra", "Other Running view_file", "Running  view_file", "client_view_file"].map((title) => ({
      name: title, call: { title }, warning: title.replace(/^Running /, ""),
    })),
    { name: "name fallback", call: { name: "view_file" } },
    { name: "title takes precedence", call: { title: "edit_file", name: "view_file" }, warning: "edit_file" },
    { name: "kind alone does not identify a native tool", call: { kind: "read" }, warning: "read" },
    { name: "registered MCP tool", call: { title: "read", _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "read" } } } },
    { name: "unregistered MCP tool", call: { title: "view_file", _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "unknown" } } }, warning: "unknown" },
    { name: "foreign MCP tool", call: { title: "Running view_file", _meta: { mcp: { server: "other", tool: "read" } } }, warning: "read" },
  ];

  for (const row of toolCases) {
    test(`tool warning identity: ${row.name}`, () => {
      const processor = new EventProcessor("session-123", new Set(["read", "bash"]));
      const events: RuntimeEvent[] = [];
      const rawInput = { file: "foo.txt" };

      processor.process({
        sessionId: "session-123",
        update: { sessionUpdate: "tool_call_update", toolCallId: "call", status: "completed", rawInput, ...row.call },
      }, "live", (event) => events.push(event));

      assert.deepEqual(events, row.warning === undefined ? [] : [{ type: "tool-warning", name: row.warning, args: rawInput }]);
    });
  }

  const warningCases: { name: string; updates: SessionNotification["update"][]; warning: string }[] = [
    {
      name: "terminal updates and completion warn once",
      updates: [
        { sessionUpdate: "tool_call", toolCallId: "call", title: "edit_file", status: "in_progress" },
        { sessionUpdate: "tool_call_update", toolCallId: "call", status: "completed" },
        { sessionUpdate: "tool_call_update", toolCallId: "call", status: "completed" },
      ],
      warning: "edit_file",
    },
    {
      name: "completion checks unfinished calls",
      updates: [{ sessionUpdate: "tool_call", toolCallId: "call", title: "edit_file", status: "in_progress" }],
      warning: "edit_file",
    },
    {
      name: "conflicting MCP identity warns once",
      updates: [
        { sessionUpdate: "tool_call", toolCallId: "call", title: "read", _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "read" } } },
        { sessionUpdate: "tool_call_update", toolCallId: "call", _meta: { mcp: { server: "other" } } },
        { sessionUpdate: "tool_call_update", toolCallId: "call", status: "completed" },
      ],
      warning: "read",
    },
  ];

  for (const row of warningCases) {
    test(`warning deduplication: ${row.name}`, () => {
      const processor = new EventProcessor("session-123", new Set(["read"]));
      const events: RuntimeEvent[] = [];
      const emit = (event: RuntimeEvent) => events.push(event);

      for (const update of row.updates) processor.process({ sessionId: "session-123", update }, "live", emit);
      processor.complete({ stopReason: "end_turn" }, emit);

      assert.deepEqual(events.filter((event) => event.type === "tool-warning"), [
        { type: "tool-warning", name: row.warning, args: undefined },
      ]);
    });
  }

  test("overflow warns once per turn without dropping updates to tracked calls", () => {
    const processor = new EventProcessor("session-123");
    const events: RuntimeEvent[] = [];
    const emit = (event: RuntimeEvent) => events.push(event);

    for (let turn = 0; turn < 2; turn++) {
      events.length = 0;
      for (let i = 0; i < 1024; i++) {
        processor.process({ sessionId: "session-123", update: {
          sessionUpdate: "tool_call", toolCallId: String(i), title: "view_file",
        } }, "live", emit);
      }
      assert.equal(events.length, 0);

      for (const id of ["overflow", "overflow", "another-overflow"]) {
        processor.process({ sessionId: "session-123", update: {
          sessionUpdate: "tool_call", toolCallId: id, title: "edit_file", status: "completed",
        } }, "live", emit);
      }
      processor.process({ sessionId: "session-123", update: {
        sessionUpdate: "tool_call_update", toolCallId: "0", title: "edit_file", status: "completed",
      } }, "live", emit);
      processor.complete({ stopReason: "end_turn" }, emit);

      assert.deepEqual(events.filter((event) => event.type === "tool-warning"), [
        { type: "tool-warning", name: "ACP tool notification limit exceeded", args: undefined },
        { type: "tool-warning", name: "edit_file", args: undefined },
      ]);
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
      },
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
