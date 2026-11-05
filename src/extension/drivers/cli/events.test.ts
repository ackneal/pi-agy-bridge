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

  const wrappedRead = {
    toolCallId: "wrapped", title: "MCP Tool read", status: "in_progress",
    rawInput: { ServerName: "pi-agy-bridge_pi", ToolName: "read", Arguments: { path: "README.md" } },
  } satisfies ToolCallUpdate;
  const wrappedCases: { name: string; calls: ToolCallUpdate[]; warned: boolean; replay?: boolean; sessionId?: string }[] = [
    { name: "CLI read wrapper", calls: [wrappedRead], warned: false },
    { name: "CLI bash wrapper", calls: [{ ...wrappedRead, title: "MCP Tool bash", rawInput: {
      ServerName: "pi-agy-bridge_pi", ToolName: "bash", Arguments: { command: "git status" },
    } }], warned: false },
    { name: "running CLI wrapper", calls: [{ ...wrappedRead, title: " Running MCP Tool read " }], warned: false },
    { name: "canonical lazy title", calls: [{ ...wrappedRead, title: "call_mcp_tool" }], warned: false },
    { name: "canonical lazy name", calls: [{ ...wrappedRead, name: "call_mcp_tool", title: "Read a file" }], warned: false },
    { name: "unrelated title cannot claim MCP", calls: [{ ...wrappedRead, title: "read" }], warned: true },
    { name: "display tool must match raw identity", calls: [{ ...wrappedRead, title: "MCP Tool bash" }], warned: true },
    { name: "canonical name cannot hide mismatched display", calls: [{ ...wrappedRead, name: "call_mcp_tool", title: "MCP Tool bash" }], warned: true },
    { name: "metadata cannot hide mismatched foreign wrapper", calls: [{
      ...wrappedRead, title: "MCP Tool bash", _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "read" } },
      rawInput: { ...wrappedRead.rawInput, ServerName: "other" },
    }], warned: true },
    { name: "foreign server", calls: [{ ...wrappedRead, rawInput: { ...wrappedRead.rawInput, ServerName: "other" } }], warned: true },
    { name: "unknown tool", calls: [{ ...wrappedRead, title: "MCP Tool unknown", rawInput: { ...wrappedRead.rawInput, ToolName: "unknown" } }], warned: true },
    { name: "missing server", calls: [{ ...wrappedRead, rawInput: { ToolName: "read" } }], warned: true },
    { name: "missing tool", calls: [{ ...wrappedRead, rawInput: { ServerName: "pi-agy-bridge_pi" } }], warned: true },
    { name: "non-string identity", calls: [{ ...wrappedRead, rawInput: { ServerName: "pi-agy-bridge_pi", ToolName: 42 } }], warned: true },
    { name: "incremental title then input", calls: [
      { toolCallId: "wrapped", title: wrappedRead.title }, wrappedRead, { toolCallId: "wrapped", status: "completed" },
    ], warned: false },
    { name: "null completion preserves identity", calls: [wrappedRead, {
      toolCallId: "wrapped", title: null, name: null, rawInput: null, status: "completed",
    }], warned: false },
    { name: "replacement snapshot cannot inherit identity", calls: [wrappedRead, {
      toolCallId: "wrapped", rawInput: { Arguments: { path: "package.json" } }, status: "completed",
    }], warned: true },
    { name: "partial raw snapshots cannot assemble identity", calls: [
      { ...wrappedRead, rawInput: { ServerName: "pi-agy-bridge_pi" } },
      { toolCallId: "wrapped", rawInput: { ToolName: "read" }, status: "completed" },
    ], warned: true },
    { name: "split title and input identity change warns", calls: [wrappedRead,
      { toolCallId: "wrapped", title: "MCP Tool bash" },
      { toolCallId: "wrapped", rawInput: { ...wrappedRead.rawInput, ToolName: "bash" }, status: "completed" },
    ], warned: true },
    { name: "incomplete snapshot cannot erase established identity", calls: [wrappedRead,
      { toolCallId: "wrapped", rawInput: {} },
      { ...wrappedRead, title: "MCP Tool bash", rawInput: { ...wrappedRead.rawInput, ToolName: "bash" }, status: "completed" },
    ], warned: true },
    { name: "metadata route cannot replace established wrapper identity", calls: [wrappedRead, {
      toolCallId: "wrapped", title: "bash", rawInput: {},
      _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "bash" } }, status: "completed",
    }], warned: true },
    { name: "registered tool identity change warns", calls: [wrappedRead, {
      ...wrappedRead, title: "MCP Tool bash", rawInput: { ...wrappedRead.rawInput, ToolName: "bash" },
    }], warned: true },
    { name: "foreign metadata cannot be bypassed", calls: [{ ...wrappedRead, _meta: { mcp: { server: "other", tool: "read" } } }], warned: true },
    { name: "registered metadata cannot hide foreign wrapper", calls: [{
      ...wrappedRead, _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "read" } },
      rawInput: { ...wrappedRead.rawInput, ServerName: "other" },
    }], warned: true },
    { name: "registered metadata must match wrapper tool", calls: [{ ...wrappedRead, _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "bash" } } }], warned: true },
    { name: "matching metadata", calls: [{ ...wrappedRead, _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "read" } } }], warned: false },
    { name: "replay ignored", calls: [wrappedRead], replay: true, warned: false },
    { name: "foreign session ignored", calls: [wrappedRead], sessionId: "other", warned: false },
    { name: "identity cannot cross call IDs", calls: [wrappedRead, { toolCallId: "other", title: "MCP Tool read", status: "completed" }], warned: true },
  ];

  for (const row of wrappedCases) {
    test(`CLI MCP wrapper: ${row.name}`, () => {
      const processor = new EventProcessor("session-123", new Set(["read", "bash"]));
      const events: RuntimeEvent[] = [];
      const emit = (event: RuntimeEvent) => events.push(event);

      for (const call of row.calls) processor.process({ sessionId: row.sessionId ?? "session-123", update: {
        ...call, sessionUpdate: "tool_call_update",
      } }, row.replay ? "replay" : "live", emit);
      processor.complete({ stopReason: "end_turn" }, emit);

      assert.equal(events.filter((event) => event.type === "tool-warning").length, row.warned ? 1 : 0);
      assert.deepEqual(events.filter((event) => event.type === "complete"), [{ type: "complete", reason: "stop", resumable: true }]);
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
