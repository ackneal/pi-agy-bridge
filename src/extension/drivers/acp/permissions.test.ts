import assert from "node:assert/strict";
import { test } from "node:test";
import type { RequestPermissionRequest, SessionNotification, ToolCallUpdate } from "@agentclientprotocol/sdk";
import { AcpMcpPermissions } from "./permissions.ts";

function call(patch: Partial<ToolCallUpdate> = {}): ToolCallUpdate {
  return { toolCallId: "id", title: "pi-agy-bridge_pi_custom", kind: "other", status: "pending",
    _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "custom" } },
    rawInput: { arguments: { arbitrary: [null, 17, { nested: true }], unrestricted: "anything" } }, ...patch };
}
function observe(gate: AcpMcpPermissions, update = call(), sessionId = "session"): void {
  const notification: SessionNotification = { sessionId, update: { ...update, sessionUpdate: "tool_call_update" } };
  gate.observe(notification);
}
function request(patch: Partial<RequestPermissionRequest> = {}): RequestPermissionRequest {
  return { sessionId: "session", toolCall: call(), options: [{ kind: "allow_once", optionId: "once", name: "Once" }], ...patch };
}

type Case = { name: string; arrange?: (gate: AcpMcpPermissions) => void; request?: RequestPermissionRequest; allowed?: boolean };
const cases: Case[] = [
  { name: "arbitrary declared MCP args", allowed: true },
  { name: "undefined kind", request: request({ toolCall: { toolCallId: "id", rawInput: call().rawInput } }), allowed: true },
  { name: "no announcement", arrange: () => {} },
  { name: "cross session request", request: request({ sessionId: "foreign" }) },
  { name: "cross session announcement", arrange: (g) => observe(g, call(), "foreign") },
  { name: "cross ID", request: request({ toolCall: call({ toolCallId: "other" }) }) },
  { name: "missing raw input", request: request({ toolCall: { toolCallId: "id" } }) },
  { name: "changed args", request: request({ toolCall: call({ rawInput: { arguments: { changed: true } } }) }) },
  { name: "array args", request: request({ toolCall: call({ rawInput: { arguments: [] } }) }) },
  { name: "allow always only", request: request({ options: [{ kind: "allow_always", optionId: "always", name: "Always" }] }) },
  ...[
    { title: "native" }, { kind: "execute" as const }, { kind: "read" as const },
    { status: "completed" as const }, { status: "failed" as const },
    { _meta: null }, { _meta: {} },
    { _meta: { mcp: { server: "foreign", tool: "custom" } } },
    { _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "terminal" } } },
    { rawInput: { arguments: { changed: true } } },
  ].map((patch, index): Case => ({ name: `conflicting update ${index} revokes permanently`, arrange: (g) => {
    observe(g); observe(g, { toolCallId: "id", ...patch }); observe(g);
  } })),
  { name: "partial updates preserve identity", arrange: (g) => {
    observe(g); observe(g, { toolCallId: "id", status: "in_progress" });
  }, allowed: true },
  { name: "partial announcement assembled", arrange: (g) => {
    observe(g, { toolCallId: "id", title: call().title! });
    observe(g, call());
  }, allowed: true },
  { name: "duplicate reply consumed", arrange: (g) => { observe(g); assert.equal(g.reply(request()).outcome.outcome, "selected"); observe(g); } },
  { name: "cancelled reply consumed", arrange: (g) => { observe(g); g.reply(request({ options: [] })); } },
  { name: "reset discards pending", arrange: (g) => { observe(g); g.reset(); } },
  { name: "limit accepts 1024", arrange: (g) => {
    observe(g); for (let i = 1; i < 1024; i++) observe(g, call({ toolCallId: String(i) }));
  }, allowed: true },
  { name: "overflow fails closed", arrange: (g) => {
    observe(g); for (let i = 1; i <= 1024; i++) observe(g, call({ toolCallId: String(i) })); observe(g);
  } },
  { name: "reset clears overflow", arrange: (g) => {
    for (let i = 0; i <= 1024; i++) observe(g, call({ toolCallId: String(i) })); g.reset(); observe(g);
  }, allowed: true },
];
for (const row of cases) test(row.name, () => {
  const gate = new AcpMcpPermissions("session", new Set(["custom"]));
  if (row.arrange) row.arrange(gate); else observe(gate);
  assert.deepEqual(gate.reply(row.request ?? request()), { outcome: row.allowed
    ? { outcome: "selected", optionId: "once" } : { outcome: "cancelled" } });
});
