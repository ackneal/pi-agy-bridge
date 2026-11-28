import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { BridgeIPC } from "../bridge/ipc.ts";
import type { DriverId, DriverSession, RuntimeEvent, ToolWarningStatus } from "../drivers/types.ts";
import { LiveSession, PiContextAdapter } from "../session/session.ts";
import { RuntimeSessionStore, RuntimeSessionSync } from "../session/state.ts";
import { PiRuntimeOutput } from "./output.ts";
import { formatToolWarning } from "./tool-warning.ts";
import { Turn } from "./turn.ts";

const model: Model<"agy"> = {
  id: "synthetic", name: "Synthetic", api: "agy", provider: "agy", baseUrl: "agy",
  reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

for (const row of [
  { name: "active output", handoff: false, throws: false },
  { name: "between Pi tool turns", handoff: true, throws: false },
  { name: "failed warning display", handoff: false, throws: true },
  { name: "tracking overflow", handoff: false, throws: false },
  { name: "repeated CLI warnings", handoff: false, throws: false, repeated: true },
]) {
  test(`Tool warning does not invalidate runtime: ${row.name}`, async (t) => {
    const driver = row.repeated ? "cli" : "acp";
    const session = new LiveSession("warning-session");
    t.after(() => session.dispose());
    let dispatch!: (event: RuntimeEvent) => void;
    const abort = t.mock.fn(async () => {});
    const proc: DriverSession = {
      driver, isRunning: true,
      onRuntimeEvent(handler) { dispatch = handler; return () => {}; },
      serializeContextUpdate: () => "", submit: async () => {}, abort,
    };
    const mcpServer = new BridgeIPC([], session.id, session.resources);
    const close = t.mock.method(mcpServer, "close");
    const preparationId = session.beginPreparation();
    assert.equal(session.setSession(proc, "sync", mcpServer, "native-session", preparationId), true);
    const adapter = new PiRuntimeOutput({ model: "synthetic", provider: "agy" });
    const onWarning = t.mock.fn((_message: string) => {
      if (row.throws) throw new Error("synthetic UI failure");
    });
    const turn = new Turn({
      session, adapter, model, context: { messages: [] }, sync: new RuntimeSessionSync(),
      store: new RuntimeSessionStore(new PiContextAdapter()), preparationId,
      signal: undefined, sessionVersion: `${driver}:v1`, onWarning,
    });
    turn.attach({ proc, mcpServer });
    if (row.handoff) adapter.handleBridgeToolCalls([{ type: "toolCall", id: "read", name: "read", arguments: {} }]);

    const args = { absolute_path: "/synthetic/output.txt" };
    const reason = row.name === "tracking overflow" ? "notification-limit" as const : undefined;
    const expected = row.repeated ? [
      "Antigravity CLI: Unverified tool activity — read_file (status: failed). (3)",
      "Antigravity CLI: Unverified tool activity — read_file (status: pending).",
      "Antigravity CLI: Unverified tool activity — write_file (status: failed).",
    ] : [reason
      ? "Antigravity ACP: Tool activity tracking limit reached; additional tool calls cannot be verified."
      : "Antigravity ACP: Unverified tool activity — view_file (status: failed)."];
    if (row.repeated) {
      dispatch({ type: "tool-warning", name: "read_file", args, status: "failed" });
      dispatch({ type: "tool-warning", name: "read_file", args, status: "pending" });
      dispatch({ type: "tool-warning", name: "read_file", args: {}, status: "failed" });
      dispatch({ type: "tool-warning", name: "write_file", args, status: "failed" });
      dispatch({ type: "tool-warning", name: "read_file", args: undefined, status: "failed" });
    } else {
      dispatch({ type: "tool-warning", name: "view_file", args, status: "failed", ...(reason ? { reason } : {}) });
    }

    assert.equal(adapter.isCompleted(), row.handoff);
    assert.equal(onWarning.mock.callCount(), row.handoff || reason ? 1 : 0);
    if (!row.handoff) {
      dispatch({ type: "text-delta", delta: "still working" });
      assert.ok(adapter.message.content.some((part) => part.type === "text" && part.text === "still working"));
      dispatch({ type: "complete", reason: "stop", resumable: true });
    }

    assert.deepEqual(onWarning.mock.calls.map(({ arguments: [message] }) => message), expected);
    assert.equal(session.activeProcess, proc);
    assert.equal(session.activeMcpServer, mcpServer);
    assert.equal(abort.mock.callCount(), 0);
    assert.equal(close.mock.callCount(), 0);
    assert.equal(adapter.isCompleted(), true);
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
