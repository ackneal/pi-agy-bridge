import assert from "node:assert/strict";
import { test, describe } from "node:test";
import type { SessionNotification, SessionUpdate, StopReason, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { RuntimeEvent } from "../types.ts";
import { EventProcessor } from "./events.ts";

const textUpdate: SessionUpdate = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } };

describe("EventProcessor notifications and completion", () => {
  for (const sessionUpdate of ["tool_call", "tool_call_update"] as const) {
    for (const kind of ["execute", "edit", "delete", "move"] as const) {
      for (const scope of ["live", "replay", "foreign"] as const) {
        test(`native notification without permission: ${sessionUpdate} ${kind} ${scope}`, () => {
          const facts: RuntimeEvent[] = [];
          const processor = new EventProcessor("session");
          processor.process({
            sessionId: scope === "foreign" ? "other" : "session",
            update: { sessionUpdate, toolCallId: "call", title: "display only", kind, status: "pending" },
          }, scope === "replay" ? "replay" : "live", (fact) => facts.push(fact));
          assert.equal(facts.length, 0, "partial announcements must have a chance to supply identity");
          if (scope === "live") processor.complete({ stopReason: "end_turn" }, (fact) => facts.push(fact));
          assert.deepEqual(facts, scope === "live" ? [{ type: "tool-warning", name: "display only", args: undefined }, { type: "session-reference", reference: "session" }, { type: "complete", reason: "stop", resumable: true }] : []);
        });
      }
    }
  }

  for (const sessionUpdate of ["tool_call", "tool_call_update"] as const) {
    for (const row of [
      { name: "client read", kind: "read", title: "read" },
      { name: "MCP other", kind: "other", title: "pi-agy-bridge_pi_edit", _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "edit" } } },
      { name: "partial announcement", title: "execute" },
      { name: "other without metadata", kind: "other", title: "delete" },
    ] satisfies { name: string; kind?: "read" | "other"; title: string; _meta?: Record<string, unknown> }[]) {
      test(`non-authoritative announcement unchanged: ${sessionUpdate} ${row.name}`, () => {
        const { name: _name, ...call } = row;
        const facts: RuntimeEvent[] = [];
        new EventProcessor("session", new Set(["edit"])).process({
          sessionId: "session", update: sessionUpdate === "tool_call"
            ? { sessionUpdate, toolCallId: "call", status: "pending", ...call }
            : { sessionUpdate, toolCallId: "call", status: "pending", ...call },
        }, "live", (fact) => facts.push(fact));
        assert.deepEqual(facts, []);
      });
    }
  }

  test("native update without title uses kind for display", () => {
    const facts: RuntimeEvent[] = [];
    const processor = new EventProcessor("session");
    processor.process({
      sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: "call", kind: "execute" },
    }, "live", (fact) => facts.push(fact));
    processor.complete({ stopReason: "end_turn" }, (fact) => facts.push(fact));
    assert.deepEqual(facts, [{ type: "tool-warning", name: "execute", args: undefined }, { type: "session-reference", reference: "session" }, { type: "complete", reason: "stop", resumable: true }]);
  });

  for (const row of [
    { name: "text delta", update: textUpdate, source: "live", sessionId: "session", expected: [{ type: "session-reference", reference: "session" }, { type: "text-delta", delta: "hello" }] },
    { name: "empty text delta", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } }, source: "live", sessionId: "session", expected: [{ type: "session-reference", reference: "session" }] },
    { name: "thought chunk ignored", update: { ...textUpdate, sessionUpdate: "agent_thought_chunk" }, source: "live", sessionId: "session", expected: [] },
    { name: "user chunk ignored", update: { ...textUpdate, sessionUpdate: "user_message_chunk" }, source: "live", sessionId: "session", expected: [] },
    { name: "image chunk ignored", update: { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "AA==", mimeType: "image/png" } }, source: "live", sessionId: "session", expected: [] },
    { name: "native tool call ignored", update: { sessionUpdate: "tool_call", toolCallId: "native", title: "read", status: "pending" }, source: "live", sessionId: "session", expected: [] },
    { name: "native tool update ignored", update: { sessionUpdate: "tool_call_update", toolCallId: "native", status: "completed" }, source: "live", sessionId: "session", expected: [] },
    { name: "replay suppressed", update: textUpdate, source: "replay", sessionId: "session", expected: [] },
    { name: "foreign session ignored", update: textUpdate, source: "live", sessionId: "other", expected: [] },
    {
      name: "usage update normalized",
      update: { sessionUpdate: "usage_update", used: 42, size: 1000 },
      source: "live",
      sessionId: "session",
      expected: [{
        type: "usage",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 42, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      }],
    },
    { name: "replay usage suppressed", update: { sessionUpdate: "usage_update", used: 42, size: 1000 }, source: "replay", sessionId: "session", expected: [] },
  ] satisfies { name: string; update: SessionUpdate; source: "live" | "replay"; sessionId: string; expected: RuntimeEvent[] }[]) {
    test(`EventProcessor.process: ${row.name}`, () => {
      const processor = new EventProcessor("session");
      const facts: RuntimeEvent[] = [];
      const notification: SessionNotification = { sessionId: row.sessionId, update: row.update };

      processor.process(notification, row.source, (fact) => facts.push(fact));

      assert.deepEqual(facts, row.expected);
    });
  }

  for (const row of [
    { reason: "end_turn", expected: { type: "complete", reason: "stop", resumable: true } },
    { reason: "cancelled", expected: { type: "complete", reason: "aborted", resumable: false } },
    { reason: "refusal", expected: { type: "complete", reason: "error", error: "ACP prompt stopped: refusal", resumable: false } },
    { reason: "max_tokens", expected: { type: "complete", reason: "error", error: "ACP prompt stopped: max_tokens", resumable: false } },
    { reason: "max_turn_requests", expected: { type: "complete", reason: "error", error: "ACP prompt stopped: max_turn_requests", resumable: false } },
  ] satisfies { reason: StopReason; expected: RuntimeEvent }[]) {
    test(`EventProcessor.complete: ${row.reason}`, () => {
      const processor = new EventProcessor("session");
      const facts: RuntimeEvent[] = [];

      processor.complete({ stopReason: row.reason }, (fact) => facts.push(fact));

      assert.deepEqual(facts, [{ type: "session-reference", reference: "session" }, row.expected]);
    });
  }
});

describe("EventProcessor tool allowlist validation and warnings", () => {
  const path = "/gemini/antigravity-acp/brain/session/.system_generated/steps/output.txt";
  const mcp = { mcp: { server: "pi-agy-bridge_pi", tool: "read" } };
  const client = {
    toolCallId: "client", title: "Running client_view_file", kind: "read", status: "in_progress",
  } satisfies ToolCallUpdate;
  type Action = { update: ToolCallUpdate; sessionId?: string; replay?: boolean };
  type Case = { name: string; actions: Action[]; warned: boolean };
  const cases: Case[] = [
    { name: "registered Pi MCP identity", actions: [{ update: { toolCallId: "mcp", kind: "other", title: "pi-agy-bridge_pi_read", _meta: mcp } }], warned: false },
    { name: "MCP completion inherits identity", actions: [
      { update: { toolCallId: "mcp", kind: "other", _meta: mcp } },
      { update: { toolCallId: "mcp", status: "completed" } },
    ], warned: false },
    { name: "title first metadata later", actions: [
      { update: { toolCallId: "mcp", kind: "read", title: "display only", status: "pending" } },
      { update: { toolCallId: "mcp", _meta: mcp } },
      { update: { toolCallId: "mcp", status: "completed" } },
    ], warned: false },
    { name: "partial metadata assembles by call ID", actions: [
      { update: { toolCallId: "mcp", _meta: { mcp: { server: "pi-agy-bridge_pi" } } } },
      { update: { toolCallId: "mcp", _meta: { mcp: { tool: "read" } } } },
      { update: { toolCallId: "mcp", _meta: { progress: 1 }, status: "completed" } },
    ], warned: false },
    { name: "foreign MCP server", actions: [{ update: { toolCallId: "mcp", _meta: { mcp: { server: "other", tool: "read" } } } }], warned: true },
    { name: "unregistered Pi tool", actions: [{ update: { toolCallId: "mcp", _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "unknown" } } } }], warned: true },
    { name: "matching title is not MCP identity", actions: [{ update: { toolCallId: "mcp", title: "pi-agy-bridge_pi_read", kind: "other", status: "completed" } }], warned: true },
    { name: "conflicting MCP identity warns once", actions: [
      { update: { toolCallId: "mcp", _meta: mcp } },
      { update: { toolCallId: "mcp", _meta: { mcp: { tool: "other" } } } },
      { update: { toolCallId: "mcp", _meta: mcp } },
    ], warned: true },
    ...(["read", "search", "execute", "edit", "delete", "move", "other"] as const).map((kind): Case => ({
      name: `unverified ${kind} activity`, actions: [{ update: { toolCallId: "native", kind, status: "completed" } }], warned: true,
    })),
    { name: "unclassified named activity at prompt end", actions: [{ update: { toolCallId: "native", title: "unknown operation", status: "in_progress" } }], warned: true },
    { name: "client announcement without callback or raw input", actions: [{ update: client }], warned: false },
    ...[
      { title: "running client_view_file", warned: false },
      { title: "RUNNING CLIENT_VIEW_FILE", warned: false },
      { title: "rUnNiNg ClIeNt_ViEw_FiLe", warned: false },
      { title: " \tRunning client_view_file\n", warned: false },
      { title: " \tRUNNING CLIENT_VIEW_FILE\n", warned: false },
      { title: "Running not_client_view_file", warned: true },
      { title: "Running client_view_file_extra", warned: true },
      { title: "Other Running client_view_file", warned: true },
      { title: "client_view_file", warned: true },
      { title: "Running  client_view_file", warned: true },
    ].map(({ title, warned }): Case => ({
      name: `client title ${JSON.stringify(title)}`, actions: [{ update: { ...client, title } }], warned,
    })),
    { name: "normalized client title with wrong kind warns", actions: [{ update: { ...client, title: " RUNNING CLIENT_VIEW_FILE ", kind: "other" } }], warned: true },
    { name: "normalized client title with foreign MCP warns", actions: [{ update: { ...client, title: " RUNNING CLIENT_VIEW_FILE ", _meta: { mcp: { server: "other", tool: "read" } } } }], warned: true },
    ...(["completed", "failed"] as const).map((status): Case => ({
      name: `client ${status} without callback`, actions: [{ update: client }, { update: { toolCallId: "client", status } }], warned: false,
    })),
    { name: "client path changes do not warn", actions: [
      { update: { ...client, rawInput: { absolute_path: path } } },
      { update: { toolCallId: "client", rawInput: { absolute_path: "/other" }, status: "completed" } },
    ], warned: false },
    { name: "native view_file is not client_view_file", actions: [{ update: { ...client, title: "Running view_file" } }], warned: true },
    { name: "client then registered MCP is trusted without identity conflict", actions: [
      { update: client }, { update: { toolCallId: "client", _meta: mcp } },
    ], warned: false },
    { name: "client with foreign MCP warns", actions: [{ update: { ...client, _meta: { mcp: { server: "other", tool: "read" } } } }], warned: true },
    { name: "client with unregistered MCP warns", actions: [{ update: { ...client, _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "unknown" } } } }], warned: true },
    { name: "client title with wrong kind warns", actions: [{ update: { ...client, kind: "other" } }], warned: true },
    { name: "client title without kind warns", actions: [{ update: { toolCallId: "client", title: client.title } }], warned: true },
    { name: "identity cannot transfer across tool IDs", actions: [{ update: { toolCallId: "mcp", _meta: mcp } }, { update: { toolCallId: "other", title: "read", status: "completed" } }], warned: true },
    { name: "replay does not populate allowlist", actions: [{ update: { toolCallId: "mcp", _meta: mcp }, replay: true }, { update: { toolCallId: "mcp", kind: "other", status: "completed" } }], warned: true },
    { name: "foreign session does not populate allowlist", actions: [{ update: { toolCallId: "mcp", _meta: mcp }, sessionId: "other" }, { update: { toolCallId: "mcp", kind: "other", status: "completed" } }], warned: true },
    { name: "status-only orphan update is not an identifiable tool", actions: [{ update: { toolCallId: "orphan", status: "completed" } }], warned: false },
  ];

  for (const row of cases) {
    test(`tool allowlist: ${row.name}`, () => {
      const processor = new EventProcessor("session", new Set(["read"]));
      const events: RuntimeEvent[] = [];

      for (const action of row.actions) {
        processor.process({ sessionId: action.sessionId ?? "session", update: { ...action.update, sessionUpdate: "tool_call_update" } },
          action.replay ? "replay" : "live", (event) => events.push(event));
      }
      processor.complete({ stopReason: "end_turn" }, (event) => events.push(event));

      assert.equal(events.filter((event) => event.type === "tool-warning").length, row.warned ? 1 : 0);
      assert.deepEqual(events.filter((event) => event.type === "complete"), [{ type: "complete", reason: "stop", resumable: true }]);
      if (row.warned) {
        const count = events.length;
        processor.process({ sessionId: "session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } } }, "live", (event) => events.push(event));
        processor.complete({ stopReason: "end_turn" }, (event) => events.push(event));
        assert.equal(events.length, count + 4, "warnings must not suppress later text or success");
      }
    });
  }

  for (const replacement of [null, "", []]) {
    test(`malformed MCP metadata cannot erase prior identity: ${JSON.stringify(replacement)}`, () => {
      const processor = new EventProcessor("session", new Set(["read", "write"]));
      const events: RuntimeEvent[] = [];
      for (const identity of [mcp, { mcp: replacement }, { mcp: { server: "pi-agy-bridge_pi", tool: "write" } }]) {
        processor.process({ sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: "same", _meta: identity } },
          "live", (event) => events.push(event));
      }
      processor.complete({ stopReason: "end_turn" }, (event) => events.push(event));
      assert.equal(events.filter((event) => event.type === "tool-warning").length, 1);
      assert.equal(events.find((event) => event.type === "tool-warning")?.name, "write");
      assert.deepEqual(events.filter((event) => event.type === "complete"), [{ type: "complete", reason: "stop", resumable: true }]);
    });
  }

  for (const row of [
    { name: "native canonical name and raw args", call: { toolCallId: "same", title: "Running view_file", rawInput: { absolute_path: path }, status: "completed" }, expectedName: "view_file", args: { absolute_path: path } },
    { name: "MCP tool and unwrapped args", call: { toolCallId: "same", _meta: { mcp: { server: "other", tool: "read" } }, rawInput: { arguments: { path } } }, expectedName: "read", args: { path } },
  ] satisfies { name: string; call: ToolCallUpdate; expectedName: string; args: unknown }[]) {
    test(`warning facts: ${row.name}`, () => {
      const processor = new EventProcessor("session", new Set(["read"]));
      const events: RuntimeEvent[] = [];
      const emit = (event: RuntimeEvent) => events.push(event);
      for (let prompt = 0; prompt < 2; prompt++) {
        processor.process({ sessionId: "session", update: { ...row.call, sessionUpdate: "tool_call_update" } }, "live", emit);
        for (const identity of [mcp, { mcp: { server: "other", tool: "changed" } }, mcp]) {
          processor.process({ sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: "same", _meta: identity } }, "live", emit);
        }
        processor.complete({ stopReason: "end_turn" }, emit);
      }
      assert.deepEqual(events.filter((event) => event.type === "tool-warning"), Array.from({ length: 2 }, () => ({ type: "tool-warning", name: row.expectedName, args: row.args })));
      assert.equal(events.filter((event) => event.type === "complete").length, 2);
    });
  }

  test("bounded notification tracking warns once on overflow per prompt without suppressing output", () => {
    const processor = new EventProcessor("session", new Set(["read"]));
    const events: RuntimeEvent[] = [];
    const emit = (event: RuntimeEvent) => events.push(event);
    for (let prompt = 0; prompt < 2; prompt++) {
      for (let id = 0; id < 1030; id++) {
        processor.process({ sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: String(id), _meta: mcp } }, "live", emit);
      }
      processor.process({ sessionId: "session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "continued" } } }, "live", emit);
      processor.complete({ stopReason: "end_turn" }, emit);
    }
    assert.deepEqual(events.filter((event) => event.type === "tool-warning"), Array.from({ length: 2 }, () => ({ type: "tool-warning", name: "ACP tool notification limit exceeded", args: undefined })));
    assert.equal(events.filter((event) => event.type === "text-delta").length, 2);
    assert.equal(events.filter((event) => event.type === "complete").length, 2);
  });
});
