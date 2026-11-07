import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { BridgeIPC } from "../bridge/ipc.ts";
import type { DriverId, DriverSession, RuntimeEvent, ToolWarningStatus } from "../drivers/types.ts";
import { LiveSession, PiContextAdapter } from "../session/session.ts";
import { RuntimeSessionStore, RuntimeSessionSync } from "../session/state.ts";
import { PiRuntimeOutput } from "./output.ts";
import { formatToolWarning } from "./tool-warning.ts";
import { Turn } from "./turn.ts";

for (const row of [
  { name: "active output", handoff: false, throws: false },
  { name: "between Pi tool turns", handoff: true, throws: false },
  { name: "failed warning display", handoff: false, throws: true },
  { name: "tracking overflow", handoff: false, throws: false },
]) {
  test(`ACP warning does not invalidate runtime: ${row.name}`, async (t) => {
    const session = new LiveSession("warning-session");
    t.after(() => session.dispose());
    let dispatch!: (event: RuntimeEvent) => void;
    const abort = t.mock.fn(async () => {});
    const proc: DriverSession = {
      driver: "acp", isRunning: true,
      onRuntimeEvent(handler) { dispatch = handler; return () => {}; },
      serializeContextUpdate: () => "", submit: async () => {}, abort,
    };
    const mcpServer = new BridgeIPC([], session.id, session.resources);
    const close = t.mock.method(mcpServer, "close");
    const preparationId = session.beginPreparation();
    assert.equal(session.setSession(proc, "sync", mcpServer, "native-session", preparationId), true);
    const adapter = new PiRuntimeOutput({ model: "synthetic", provider: "agy" });
    const onWarning = t.mock.fn((_name: string, _args: unknown, _status: ToolWarningStatus) => {
      if (row.throws) throw new Error("synthetic UI failure");
    });
    const turn = new Turn({
      session, adapter, context: { messages: [] }, sync: new RuntimeSessionSync(),
      store: new RuntimeSessionStore(new PiContextAdapter()), preparationId,
      signal: undefined, sessionVersion: "acp:v1", onWarning,
    });
    turn.attach({ proc, mcpServer });
    if (row.handoff) adapter.handleBridgeToolCalls([{ type: "toolCall", id: "read", name: "read", arguments: {} }]);

    const args = { absolute_path: "/synthetic/output.txt" };
    const reason = row.name === "tracking overflow" ? "notification-limit" as const : undefined;
    dispatch({ type: "tool-warning", name: "view_file", args, status: "failed", ...(reason ? { reason } : {}) });

    assert.equal(onWarning.mock.callCount(), 1);
    assert.deepEqual(onWarning.mock.calls[0]!.arguments, ["view_file", args, "failed", reason]);
    assert.equal(session.activeProcess, proc);
    assert.equal(session.activeMcpServer, mcpServer);
    assert.equal(abort.mock.callCount(), 0);
    assert.equal(close.mock.callCount(), 0);
    assert.equal(adapter.isCompleted(), row.handoff);
    if (!row.handoff) {
      dispatch({ type: "text-delta", delta: "still working" });
      assert.ok(adapter.message.content.some((part) => part.type === "text" && part.text === "still working"));
    }
  });
}

describe("formatToolWarning", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const throwing = { toJSON() { throw new Error("must not serialize input"); } };
  const cases: { title: string; name: string; args: unknown; expected: string; status?: ToolWarningStatus }[] = [
    { title: "completed activity", name: "view_file", args: { path: "/tmp/private" }, expected: "view_file", status: "completed" },
    { title: "in-progress activity", name: "search", args: {}, expected: "search", status: "in_progress" },
    { title: "pending activity", name: "search", args: undefined, expected: "search", status: "pending" },
    { title: "unknown status", name: "search", args: null, expected: "search", status: "unknown" },
    { title: "sensitive input omitted", name: "tool", args: { secret: "private" }, expected: "tool" },
    { title: "circular input ignored", name: "tool", args: circular, expected: "tool" },
    { title: "serialization not invoked", name: "tool", args: throwing, expected: "tool" },
    { title: "terminal controls removed", name: "\u001b[31mview\u001b[0m\nfile\tname\r!", args: {}, expected: "view file name !" },
    { title: "bounded name", name: "n".repeat(121), args: {}, expected: `${"n".repeat(119)}…` },
    { title: "empty name", name: "", args: {}, expected: "unknown tool" },
    { title: "blank name", name: " \t\n", args: {}, expected: "unknown tool" },
    { title: "control-only name", name: "\u001b[31m\u0000\u2028\u2029", args: {}, expected: "unknown tool" },
  ];

  for (const driver of ["acp", "cli"] satisfies DriverId[]) {
    test(`${driver}: tracking overflow has a distinct diagnostic`, () => {
      const result = formatToolWarning(driver, "unknown tool", undefined, "unknown", "notification-limit");

      assert.equal(result, `Antigravity ${driver.toUpperCase()}: Tool activity tracking limit reached; additional tool calls cannot be verified.`);
    });

    for (const row of cases) {
      test(`${driver}: ${row.title}`, () => {
        const status = row.status ?? "failed";
        const result = formatToolWarning(driver, row.name, row.args, status);

        assert.equal(result, `Antigravity ${driver.toUpperCase()}: Unverified tool activity — ${row.expected} (status: ${status}).`);
        assert.ok(!/[\r\n\u2028\u2029]/.test(result));
      });
    }
  }
});
