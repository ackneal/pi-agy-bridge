import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import type { SessionNotification, ToolCallUpdate } from "@agentclientprotocol/sdk";
import { EventProcessor } from "./events.ts";
import { expandHome } from "../../shared/paths.ts";
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

  test("handles agent_thought_chunk updates", () => {
    const cases: {
      name: string;
      sessionId: string;
      source: "live" | "replay";
      update: SessionNotification["update"];
      expected: RuntimeEvent[];
    }[] = [
      {
        name: "live text thought delta",
        sessionId: "session-123",
        source: "live",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking..." } },
        expected: [{ type: "session-reference", reference: "session-123" }, { type: "thinking-delta", delta: "Thinking..." }],
      },
      {
        name: "empty text thought delta",
        sessionId: "session-123",
        source: "live",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "" } },
        expected: [{ type: "session-reference", reference: "session-123" }],
      },
      {
        name: "replay thought suppressed",
        sessionId: "session-123",
        source: "replay",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking..." } },
        expected: [],
      },
      {
        name: "foreign session thought ignored",
        sessionId: "other-session",
        source: "live",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking..." } },
        expected: [],
      },
      {
        name: "non-text thought ignored",
        sessionId: "session-123",
        source: "live",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "image", data: "AA==", mimeType: "image/png" } },
        expected: [],
      },
    ];

    for (const row of cases) {
      const processor = new EventProcessor("session-123");
      const events: RuntimeEvent[] = [];
      processor.process({ sessionId: row.sessionId, update: row.update }, row.source, (e) => events.push(e));
      assert.deepEqual(events, row.expected, row.name);
    }
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

  const artifactSession = "550e8400-e29b-41d4-a716-446655440000";
  const geminiHome = expandHome(process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini"));
  const stepsRoot = path.resolve(geminiHome, "antigravity-cli", "brain", artifactSession, ".system_generated", "steps");
  const artifactTitle = `File brain/${artifactSession}/.system_generated/steps/1/output.txt`;
  const artifactInput = { Path: path.join(stepsRoot, "1", "output.txt") };
  const mcpRoot = path.resolve(geminiHome, "antigravity-cli", "mcp", "pi-agy-bridge_pi");
  const mcpSchemaInput = { Path: path.join(mcpRoot, "read.json") };
  const mcpSchemaTitle = `File mcp/pi-agy-bridge_pi/read.json`;

  const toolCases: { name: string; call: Omit<ToolCallUpdate, "toolCallId">; warning?: string }[] = [
    ...["read_file", "Running read_file", " \tRUNNING READ_FILE\n"].map((title) => ({ name: title, call: { title } })),
    ...["view_file", "Running view_file", "not_read_file", "read_file_extra", "Running read_file_extra", "Other Running read_file", "Running  read_file", "client_view_file"].map((title) => ({
      name: title, call: { title }, warning: "unknown tool",
    })),
    { name: "name fallback", call: { name: "read_file" } },
    { name: "name identifies tool despite conflicting title", call: { title: "edit_file", name: "read_file" }, warning: "read_file" },
    { name: "kind alone does not identify a native tool", call: { kind: "read" }, warning: "unknown tool" },
    { name: "registered MCP tool", call: { title: "read", _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "read" } } } },
    { name: "unregistered MCP tool", call: { title: "read_file", _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "unknown" } } }, warning: "unknown" },
    { name: "foreign MCP tool", call: { title: "Running read_file", _meta: { mcp: { server: "other", tool: "read" } } }, warning: "read" },
  ];

  for (const row of toolCases) {
    test(`tool warning identity: ${row.name}`, () => {
      const processor = new EventProcessor(artifactSession, new Set(["read", "bash"]));
      const events: RuntimeEvent[] = [];
      const rawInput = artifactInput;

      processor.process({
        sessionId: artifactSession,
        update: { sessionUpdate: "tool_call_update", toolCallId: "call", status: "completed", rawInput, ...row.call },
      }, "live", (event) => events.push(event));

      assert.deepEqual(events, row.warning === undefined ? [] : [{ type: "tool-warning", name: row.warning, args: rawInput, status: "completed" }]);
    });
  }

  const artifactCall = {
    toolCallId: "artifact", title: artifactTitle, rawInput: artifactInput, status: "completed",
  } satisfies ToolCallUpdate;
  const artifactCases: {
    name: string; calls: ToolCallUpdate[]; warned: boolean; sessionId?: string; warningName?: string;
  }[] = [
    { name: "session UUID artifact", calls: [artifactCall], warned: false },
    { name: "MCP tool schema path", calls: [{ toolCallId: "mcp-schema", title: mcpSchemaTitle, rawInput: mcpSchemaInput, status: "completed" }], warned: false },
    { name: "MCP tool schema native title", calls: [{ toolCallId: "mcp-schema", title: "read_file", rawInput: mcpSchemaInput, status: "completed" }], warned: false },
    { name: "MCP foreign server path", calls: [{ toolCallId: "foreign-schema", title: "read_file", rawInput: { Path: path.resolve(geminiHome, "antigravity-cli", "mcp", "other", "read.json") }, status: "completed" }], warned: true },
    { name: "MCP non-schema file", calls: [{ toolCallId: "mcp-txt", title: "read_file", rawInput: { Path: path.join(mcpRoot, "notes.txt") }, status: "completed" }], warned: true },
    { name: "read kind", calls: [{ ...artifactCall, kind: "read" }], warned: false },
    { name: "native title still checks path", calls: [{ ...artifactCall, title: "read_file", rawInput: { Path: "/tmp/outside-artifact.txt" } }], warned: true },
    { name: "native title still checks name", calls: [{ ...artifactCall, title: "read_file", name: "edit_file" }], warned: true },
    { name: "native title still checks kind", calls: [{ ...artifactCall, title: "read_file", kind: "edit" }], warned: true },
    { name: "native title requires input", calls: [{ ...artifactCall, title: "read_file", rawInput: undefined }], warned: true },
    { name: "name-only still checks path", calls: [{ ...artifactCall, title: null, name: "read_file", rawInput: { Path: "/tmp/outside-artifact.txt" } }], warned: true, warningName: "read_file" },
    { name: "null kind", calls: [{ ...artifactCall, kind: null }], warned: false },
    { name: "explicit native name", calls: [{ ...artifactCall, name: "read_file" }], warned: false },
    { name: "line range", calls: [{ ...artifactCall, name: "read_file", rawInput: { ...artifactInput, StartLine: 1, EndLine: 20 } }], warned: false },
    { name: "legacy native name", calls: [{ ...artifactCall, name: "view_file" }], warned: true },
    { name: "legacy path field", calls: [{ ...artifactCall, rawInput: { AbsolutePath: artifactInput.Path } }], warned: true },
    { name: "split title then input", calls: [
      { toolCallId: "artifact", title: artifactTitle },
      { toolCallId: "artifact", rawInput: artifactInput },
      { toolCallId: "artifact", status: "completed" },
    ], warned: false },
    { name: "split input then title", calls: [
      { toolCallId: "artifact", rawInput: artifactInput },
      { toolCallId: "artifact", title: artifactTitle, status: "completed" },
    ], warned: false },
    { name: "unrelated absolute file", calls: [{ ...artifactCall, rawInput: { Path: "/tmp/output.txt" } }], warned: true },
    { name: "other session path", calls: [{ ...artifactCall, rawInput: {
      Path: artifactInput.Path.replace(artifactSession, "other-session"),
    } }], warned: true },
    { name: "other session title and path", calls: [{ ...artifactCall,
      title: artifactTitle.replace(artifactSession, "other-session"),
      rawInput: { Path: artifactInput.Path.replace(artifactSession, "other-session") },
    }], warned: true },
    { name: "unsafe session ID", sessionId: "../escape", calls: [{ ...artifactCall,
      title: "File brain/../escape/.system_generated/steps/output.txt",
      rawInput: { Path: path.resolve(stepsRoot, "../../../..", "escape/.system_generated/steps/output.txt") },
    }], warned: true },
    { name: "noncanonical traversal inside root", calls: [{ ...artifactCall,
      rawInput: { Path: `${stepsRoot}/1/../1/output.txt` },
    }], warned: true },
    { name: "traversal outside root", calls: [{ ...artifactCall,
      title: `File brain/${artifactSession}/.system_generated/steps/../output.txt`,
      rawInput: { Path: `${stepsRoot}/../output.txt` },
    }], warned: true },
    { name: "sibling prefix", calls: [{ ...artifactCall,
      rawInput: { Path: `${stepsRoot}-other/1/output.txt` },
    }], warned: true },
    { name: "relative path", calls: [{ ...artifactCall,
      rawInput: { Path: `brain/${artifactSession}/.system_generated/steps/1/output.txt` },
    }], warned: true },
    { name: "root is not a file", calls: [{ ...artifactCall,
      title: `File brain/${artifactSession}/.system_generated/steps/`, rawInput: { Path: stepsRoot },
    }], warned: true },
    ...["File unrelated.txt", `${artifactTitle} extra`, ` ${artifactTitle}`, artifactTitle.toLowerCase(), "Running " + artifactTitle].map((title) => ({
      name: `exact title required: ${title}`, calls: [{ ...artifactCall, title }], warned: true,
    })),
    { name: "name cannot override mismatched title", calls: [{ ...artifactCall, title: "File unrelated.txt", name: "read_file" }], warned: true },
    { name: "bad explicit name", calls: [{ ...artifactCall, name: "edit_file" }], warned: true },
    ...(["edit", "execute"] as const).map((kind) => ({
      name: `reject ${kind} kind`, calls: [{ ...artifactCall, kind }], warned: true,
    })),
    { name: "missing input", calls: [{ ...artifactCall, rawInput: undefined }], warned: true },
    { name: "missing Path", calls: [{ ...artifactCall, rawInput: {} }], warned: true },
    { name: "non-string Path", calls: [{ ...artifactCall, rawInput: { Path: 42 } }], warned: true },
    { name: "empty MCP metadata", calls: [{ ...artifactCall, _meta: { mcp: {} } }], warned: true },
    { name: "foreign MCP metadata", calls: [{ ...artifactCall,
      _meta: { mcp: { server: "foreign", tool: "read" } },
    }], warned: true, warningName: "read" },
    { name: "foreign wrapped claim", calls: [{ ...artifactCall, name: "call_mcp_tool",
      rawInput: { ...artifactInput, ServerName: "foreign", ToolName: "read", Arguments: {} },
    }], warned: true, warningName: "read" },
  ];

  for (const row of artifactCases) {
    test(`CLI native artifact: ${row.name}`, () => {
      const sessionId = row.sessionId ?? artifactSession;
      const processor = new EventProcessor(sessionId, new Set(["read", "bash"]));
      const events: RuntimeEvent[] = [];
      const emit = (event: RuntimeEvent) => events.push(event);

      for (const call of row.calls) processor.process({ sessionId, update: {
        ...call, sessionUpdate: "tool_call_update",
      } }, "live", emit);
      processor.complete({ stopReason: "end_turn" }, emit);

      const warnings = events.filter((event) => event.type === "tool-warning");
      assert.equal(warnings.length, row.warned ? 1 : 0);
      if (row.warned) assert.equal(warnings[0]?.name, row.warningName ?? row.calls.at(-1)?.name ?? "unknown tool");
      assert.deepEqual(events.filter((event) => event.type === "complete"), [
        { type: "complete", reason: "stop", resumable: true },
      ]);
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

  const warningCases: { name: string; updates: SessionNotification["update"][]; warning: string; status: string }[] = [
    {
      name: "terminal updates and completion warn once",
      updates: [
        { sessionUpdate: "tool_call", toolCallId: "call", title: "edit_file", status: "in_progress" },
        { sessionUpdate: "tool_call_update", toolCallId: "call", status: "completed" },
        { sessionUpdate: "tool_call_update", toolCallId: "call", status: "completed" },
      ],
      warning: "unknown tool", status: "completed",
    },
    {
      name: "completion checks unfinished calls",
      updates: [{ sessionUpdate: "tool_call", toolCallId: "call", title: "edit_file", status: "in_progress" }],
      warning: "unknown tool", status: "in_progress",
    },
    {
      name: "conflicting MCP identity warns once",
      updates: [
        { sessionUpdate: "tool_call", toolCallId: "call", title: "read", _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "read" } } },
        { sessionUpdate: "tool_call_update", toolCallId: "call", _meta: { mcp: { server: "other" } } },
        { sessionUpdate: "tool_call_update", toolCallId: "call", status: "completed" },
      ],
      warning: "read", status: "unknown",
    },
    { name: "failed tool preserves status", updates: [
      { sessionUpdate: "tool_call_update", toolCallId: "call", title: "edit_file", status: "failed" },
    ], warning: "unknown tool", status: "failed" },
    ...([null, undefined] as const).map((status) => ({
      name: `identity conflict retains prior status when ${status}`,
      updates: [
        { sessionUpdate: "tool_call" as const, toolCallId: "call", title: "read", status: "pending" as const, _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "read" } } },
        { sessionUpdate: "tool_call_update" as const, toolCallId: "call", ...(status === undefined ? {} : { status }), _meta: { mcp: { server: "other" } } },
      ], warning: "read", status: "pending",
    })),
  ];

  for (const row of warningCases) {
    test(`warning deduplication: ${row.name}`, () => {
      const processor = new EventProcessor("session-123", new Set(["read"]));
      const events: RuntimeEvent[] = [];
      const emit = (event: RuntimeEvent) => events.push(event);

      for (const update of row.updates) processor.process({ sessionId: "session-123", update }, "live", emit);
      processor.complete({ stopReason: "end_turn" }, emit);

      assert.deepEqual(events.filter((event) => event.type === "tool-warning"), [
        { type: "tool-warning", name: row.warning, args: undefined, status: row.status },
      ]);
    });
  }

  test("overflow warns once per turn without dropping updates to tracked calls", () => {
    const processor = new EventProcessor(artifactSession);
    const events: RuntimeEvent[] = [];
    const emit = (event: RuntimeEvent) => events.push(event);

    for (let turn = 0; turn < 2; turn++) {
      events.length = 0;
      for (let i = 0; i < 1024; i++) {
        processor.process({ sessionId: artifactSession, update: {
          sessionUpdate: "tool_call", toolCallId: String(i), title: "read_file", rawInput: artifactInput,
        } }, "live", emit);
      }
      assert.equal(events.length, 0);

      for (const id of ["overflow", "overflow", "another-overflow"]) {
        processor.process({ sessionId: artifactSession, update: {
          sessionUpdate: "tool_call", toolCallId: id, title: "edit_file", status: "completed",
        } }, "live", emit);
      }
      processor.process({ sessionId: artifactSession, update: {
        sessionUpdate: "tool_call_update", toolCallId: "0", title: "edit_file", status: "completed",
      } }, "live", emit);
      processor.complete({ stopReason: "end_turn" }, emit);

      assert.deepEqual(events.filter((event) => event.type === "tool-warning"), [
        { type: "tool-warning", name: "unknown tool", args: undefined, status: "unknown", reason: "notification-limit" },
        { type: "tool-warning", name: "unknown tool", args: artifactInput, status: "completed" },
      ]);
    }
  });

  for (const row of [
    { name: "reported total differs from components", totalTokens: 1000, expected: 1000 },
    { name: "reported zero is preserved", totalTokens: 0, expected: 0 },
    { name: "missing total falls back to components", totalTokens: undefined, expected: 120 },
    { name: "invalid total falls back to components", totalTokens: Number.NaN, expected: 120 },
    { name: "negative total falls back to components", totalTokens: -1, expected: 120 },
  ]) {
    test(`complete usage total: ${row.name}`, () => {
      const processor = new EventProcessor("session-123");
      const events: RuntimeEvent[] = [];

      const usage = { inputTokens: 100, outputTokens: 20, totalTokens: row.totalTokens ?? 120 };
      if (row.totalTokens === undefined) Reflect.deleteProperty(usage, "totalTokens");

      processor.complete({ stopReason: "end_turn", usage }, (event) => events.push(event));

      const accounting = events.find((event) => event.type === "accounting");
      assert.ok(accounting);
      assert.equal(accounting.usage.totalTokens, row.expected);
      assert.equal(accounting.usage.input, 100);
      assert.equal(accounting.usage.output, 20);
    });
  }

  for (const row of [
    { name: "30 model calls in one prompt", input: 123355, output: 6774, cacheRead: 887639, reasoning: 3933, total: 1017768 },
    { name: "two model calls in next prompt", input: 67036, output: 749, cacheRead: 62395, reasoning: 429, total: 130180 },
    { name: "cache writes are separate from uncached input", input: 100, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 0, total: 190 },
  ]) {
    test(`CLI exclusive input accounting: ${row.name}`, () => {
      const processor = new EventProcessor("session-123");
      const events: RuntimeEvent[] = [];

      processor.complete({ stopReason: "end_turn", usage: {
        inputTokens: row.input, outputTokens: row.output, cachedReadTokens: row.cacheRead,
        cachedWriteTokens: row.cacheWrite ?? 0, thoughtTokens: row.reasoning, totalTokens: row.total,
      } }, (event) => events.push(event));

      const accounting = events.find((event) => event.type === "accounting");
      assert.ok(accounting);
      assert.equal(accounting.usage.input, row.input);
      assert.equal(accounting.usage.output, row.output);
      assert.equal(accounting.usage.cacheRead, row.cacheRead);
      assert.equal(accounting.usage.cacheWrite, row.cacheWrite ?? 0);
      assert.equal(accounting.usage.totalTokens, row.total);
      assert.equal(accounting.usage.input + accounting.usage.output + accounting.usage.cacheRead + accounting.usage.cacheWrite, row.total);
    });
  }

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
          totalTokens: 180,
        },
      },
      emit
    );

    const accounting = events.find((e) => e.type === "accounting");
    assert.ok(accounting);
    if (accounting?.type === "accounting") {
      assert.equal(accounting.usage.input, 100);
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
