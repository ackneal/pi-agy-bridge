import assert from "node:assert/strict";
import test from "node:test";
import type { ReadTextFileRequest, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { RuntimeEvent } from "../types.ts";
import { AcpEventTranslator } from "./events.ts";

const path = "/gemini/antigravity-acp/brain/session/.system_generated/steps/output.txt";
const mcp = { mcp: { server: "pi-agy-bridge_pi", tool: "read" } };
const client = {
  toolCallId: "client", title: "Running client_view_file", kind: "read", status: "in_progress", rawInput: { absolute_path: path },
} satisfies ToolCallUpdate;
type Action = { update: ToolCallUpdate; sessionId?: string; replay?: boolean } | { read: ReadTextFileRequest };
const read: Action = { read: { sessionId: "session", path } };
type Case = { name: string; actions: Action[]; blocked: boolean };
const cases: Case[] = [
  { name: "registered Pi MCP identity", actions: [{ update: { toolCallId: "mcp", kind: "other", title: "pi-agy-bridge_pi_read", _meta: mcp } }], blocked: false },
  { name: "MCP completion inherits identity", actions: [
    { update: { toolCallId: "mcp", kind: "other", _meta: mcp } },
    { update: { toolCallId: "mcp", status: "completed" } },
  ], blocked: false },
  { name: "title first metadata later", actions: [
    { update: { toolCallId: "mcp", kind: "read", title: "display only", status: "pending" } },
    { update: { toolCallId: "mcp", _meta: mcp } },
    { update: { toolCallId: "mcp", status: "completed" } },
  ], blocked: false },
  { name: "partial metadata assembles by call ID", actions: [
    { update: { toolCallId: "mcp", _meta: { mcp: { server: "pi-agy-bridge_pi" } } } },
    { update: { toolCallId: "mcp", _meta: { mcp: { tool: "read" } } } },
    { update: { toolCallId: "mcp", _meta: { progress: 1 }, status: "completed" } },
  ], blocked: false },
  { name: "foreign MCP server", actions: [{ update: { toolCallId: "mcp", _meta: { mcp: { server: "other", tool: "read" } } } }], blocked: true },
  { name: "unregistered Pi tool", actions: [{ update: { toolCallId: "mcp", _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "unknown" } } } }], blocked: true },
  { name: "matching title is not MCP identity", actions: [{ update: { toolCallId: "mcp", title: "pi-agy-bridge_pi_read", kind: "other", status: "completed" } }], blocked: true },
  { name: "conflicting MCP identity warns once", actions: [
    { update: { toolCallId: "mcp", _meta: mcp } },
    { update: { toolCallId: "mcp", _meta: { mcp: { tool: "other" } } } },
    { update: { toolCallId: "mcp", _meta: mcp } },
  ], blocked: true },
  ...(["read", "search", "execute", "edit", "delete", "move", "other"] as const).map((kind): Case => ({
    name: `unverified ${kind} activity`, actions: [{ update: { toolCallId: "native", kind, status: "completed" } }], blocked: true,
  })),
  { name: "unclassified named activity at prompt end", actions: [{ update: { toolCallId: "native", title: "unknown operation", status: "in_progress" } }], blocked: true },
  { name: "actual client callback precedes announcement", actions: [read, { update: client }, { update: { toolCallId: "client", status: "completed" } }], blocked: false },
  { name: "actual callback follows partial announcement", actions: [{ update: { toolCallId: "client", title: client.title, kind: "read" } }, read,
    { update: { toolCallId: "client", rawInput: client.rawInput, status: "completed" } }], blocked: false },
  { name: "client title alone is not an observed route", actions: [{ update: client }, { update: { toolCallId: "client", status: "completed" } }], blocked: true },
  { name: "native view_file is not client_view_file", actions: [read, { update: { ...client, title: "Running view_file" } }], blocked: true },
  { name: "different callback path", actions: [{ read: { sessionId: "session", path: "/other" } }, { update: client }], blocked: true },
  { name: "foreign callback session", actions: [{ read: { sessionId: "other", path } }, { update: client }], blocked: true },
  { name: "one callback cannot justify two tool calls", actions: [read, { update: client }, { update: { ...client, toolCallId: "second" } }], blocked: true },
  { name: "repeated reads require separate callbacks", actions: [read, read, { update: client }, { update: { ...client, toolCallId: "second" } }], blocked: false },
  { name: "changed client path loses correlation", actions: [read, { update: client }, { update: { toolCallId: "client", rawInput: { absolute_path: "/other" } } }], blocked: true },
  { name: "client route cannot become MCP identity", actions: [read, { update: client }, { update: { toolCallId: "client", _meta: mcp } }], blocked: true },
  { name: "identity cannot transfer across tool IDs", actions: [{ update: { toolCallId: "mcp", _meta: mcp } }, { update: { toolCallId: "other", title: "read", status: "completed" } }], blocked: true },
  { name: "replay does not populate allowlist", actions: [{ update: { toolCallId: "mcp", _meta: mcp }, replay: true }, { update: { toolCallId: "mcp", kind: "other", status: "completed" } }], blocked: true },
  { name: "foreign session does not populate allowlist", actions: [{ update: { toolCallId: "mcp", _meta: mcp }, sessionId: "other" }, { update: { toolCallId: "mcp", kind: "other", status: "completed" } }], blocked: true },
  { name: "status-only orphan update is not an identifiable tool", actions: [{ update: { toolCallId: "orphan", status: "completed" } }], blocked: false },
];

for (const row of cases) {
  test(`tool allowlist: ${row.name}`, () => {
    const translator = new AcpEventTranslator("session", new Set(["read"]));
    const events: RuntimeEvent[] = [];
    for (const action of row.actions) {
      if ("read" in action) translator.observeClientRead(action.read);
      else translator.translate({ sessionId: action.sessionId ?? "session", update: { ...action.update, sessionUpdate: "tool_call_update" } },
        action.replay ? "replay" : "live", (event) => events.push(event));
    }
    translator.complete({ stopReason: "end_turn" }, (event) => events.push(event));

    assert.equal(events.filter((event) => event.type === "tool-warning").length, row.blocked ? 1 : 0);
    assert.equal(events.filter((event) => event.type === "complete").length, 1);
    if (row.blocked) {
      const count = events.length;
      translator.translate({ sessionId: "session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } } }, "live", (event) => events.push(event));
      translator.complete({ stopReason: "end_turn" }, (event) => events.push(event));
      assert.equal(events.length, count + 4, "warnings must not suppress later text or success");
    }
  });
}

test("client callback evidence cannot leak into the next prompt", () => {
  const translator = new AcpEventTranslator("session", new Set());
  const events: RuntimeEvent[] = [];
  translator.observeClientRead({ sessionId: "session", path });
  translator.complete({ stopReason: "end_turn" }, (event) => events.push(event));
  translator.translate({ sessionId: "session", update: { ...client, sessionUpdate: "tool_call_update" } }, "live", (event) => events.push(event));
  translator.complete({ stopReason: "end_turn" }, (event) => events.push(event));
  assert.equal(events.filter((event) => event.type === "tool-warning").length, 1);
});

for (const replacement of [null, "", []]) {
  test(`malformed MCP metadata cannot erase prior identity: ${JSON.stringify(replacement)}`, () => {
    const translator = new AcpEventTranslator("session", new Set(["read", "write"]));
    const events: RuntimeEvent[] = [];
    for (const identity of [mcp, { mcp: replacement }, { mcp: { server: "pi-agy-bridge_pi", tool: "write" } }]) {
      translator.translate({ sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: "same", _meta: identity } },
        "live", (event) => events.push(event));
    }
    translator.complete({ stopReason: "end_turn" }, (event) => events.push(event));
    assert.equal(events.filter((event) => event.type === "tool-warning").length, 1);
    assert.equal(events.find((event) => event.type === "tool-warning")?.name, "write");
    assert.equal(events.filter((event) => event.type === "complete").length, 1);
  });
}

for (const row of [
  { name: "native canonical name and raw args", call: { toolCallId: "same", title: "Running view_file", rawInput: { absolute_path: path }, status: "completed" }, expectedName: "view_file", args: { absolute_path: path } },
  { name: "MCP tool and unwrapped args", call: { toolCallId: "same", _meta: { mcp: { server: "other", tool: "read" } }, rawInput: { arguments: { path } } }, expectedName: "read", args: { path } },
] satisfies { name: string; call: ToolCallUpdate; expectedName: string; args: unknown }[]) {
  test(`warning facts: ${row.name}`, () => {
    const translator = new AcpEventTranslator("session", new Set(["read"]));
    const events: RuntimeEvent[] = [];
    const emit = (event: RuntimeEvent) => events.push(event);
    for (let prompt = 0; prompt < 2; prompt++) {
      translator.translate({ sessionId: "session", update: { ...row.call, sessionUpdate: "tool_call_update" } }, "live", emit);
      for (const identity of [mcp, { mcp: { server: "other", tool: "changed" } }, mcp]) {
        translator.translate({ sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: "same", _meta: identity } }, "live", emit);
      }
      translator.complete({ stopReason: "end_turn" }, emit);
    }
    assert.deepEqual(events.filter((event) => event.type === "tool-warning"), Array.from({ length: 2 }, () => ({ type: "tool-warning", name: row.expectedName, args: row.args })));
    assert.equal(events.filter((event) => event.type === "complete").length, 2);
  });
}

test("bounded notification tracking warns once on overflow per prompt without suppressing output", () => {
  const translator = new AcpEventTranslator("session", new Set(["read"]));
  const events: RuntimeEvent[] = [];
  const emit = (event: RuntimeEvent) => events.push(event);
  for (let prompt = 0; prompt < 2; prompt++) {
    for (let id = 0; id < 1030; id++) {
      translator.translate({ sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: String(id), _meta: mcp } }, "live", emit);
    }
    translator.translate({ sessionId: "session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "continued" } } }, "live", emit);
    translator.complete({ stopReason: "end_turn" }, emit);
  }
  assert.deepEqual(events.filter((event) => event.type === "tool-warning"), Array.from({ length: 2 }, () => ({ type: "tool-warning", name: "ACP tool notification limit exceeded", args: undefined })));
  assert.equal(events.filter((event) => event.type === "text-delta").length, 2);
  assert.equal(events.filter((event) => event.type === "complete").length, 2);
});
