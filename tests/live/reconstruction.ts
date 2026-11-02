import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Message, Model, AssistantMessage } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Connection } from "../../src/extension/drivers/acp/connection.ts";
import { RuntimeSession, serializeContent } from "../../src/extension/drivers/acp/runtime.ts";
import type { DriverSubmission, PrepareDriverInput } from "../../src/extension/drivers/types.ts";
import { createLivePiSession } from "./pi-session.ts";
import { ScenarioFailure } from "./report.ts";

const toolName = "mcp__pi__history_probe";
const operations = ["confirmed", "failed", "cancelled", "unresolved"] as const;
const expected = { confirmed: "SUCCESS", failed: "ERROR", cancelled: "ABORTED", unresolved: "UNKNOWN" };

// Imported records are owned by this test, not receipts from a backend execution.
export function reconstructionHistory(model: Model<any>, hidden: string): Message[] {
  const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
    role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: 1,
  });
  return operations.flatMap((operation): Message[] => {
    const call = assistant([{ type: "toolCall", id: `fixture-${operation}`, name: toolName, arguments: { operation } }], "toolUse");
    if (operation === "unresolved") return [call, assistant([], "stop")];
    return [call, { role: "toolResult", toolCallId: `fixture-${operation}`, toolName,
      content: [{ type: "text", text: operation === "confirmed" ? hidden : operation === "failed" ? "fixture failure" : "Operation aborted" }],
      isError: operation !== "confirmed", timestamp: 2 }, assistant([], "stop")];
  });
}

export function assertReconstructionRecords(text: string, hidden: string): void {
  for (const operation of operations) {
    const suffix = operation === "confirmed" ? "" : operation === "failed" ? " — ERROR: fixture failure" : ` — ${expected[operation]}`;
    assert.ok(text.split("\n").includes(`- ${toolName}(operation="${operation}")${suffix}`), `records.${operation}: expected production status record`);
  }
  assert.equal(text.includes(hidden), false, "records.hiddenBody: result body must be omitted");
}

export function assertReconstructionAnswer(text: string): void {
  let answer: unknown;
  try { answer = JSON.parse(text); } catch { assert.fail("answer.json: expected bare JSON"); }
  assert.ok(answer && typeof answer === "object", "answer.object: expected object");
  const record = answer as Record<string, unknown>;
  assert.deepEqual(record.classifications, expected, "answer.classifications: historical outcomes");
  assert.equal(record.bodyKnown, false, "answer.bodyKnown: omitted receipt is unknowable");
  assert.equal(record.retry, false, "answer.retry: no historical work requested");
}

export async function runLiveReconstruction(options: {
  cwd: string; directory: string; model: Model<any>; launch: { executable: string; args: string[] };
  signal: AbortSignal; t: TestContext; evidence: unknown[];
  onToolCall: (call: { id: string; name: string; arguments: unknown }) => void;
}): Promise<void> {
  const { t, evidence, signal } = options;
  const executions: unknown[] = [];
  const tool = defineTool({ name: toolName, label: "History probe", description: "Test-owned historical operation probe. Do not retry historical operations.",
    parameters: Type.Object({ operation: Type.String() }),
    async execute(id, args) {
      executions.push(args);
      options.onToolCall({ id, name: toolName, arguments: args });
      return { content: [{ type: "text", text: "Unexpected retry" }], details: {} };
    },
  });
  const fixture = await createLivePiSession({ ...options, tool });
  const { session, bridge } = fixture;
  const hidden = `hidden-receipt-${randomUUID()}`;
  const preparations = new Map<RuntimeSession, boolean>();
  const submissions: { proc: RuntimeSession; messages: DriverSubmission["messages"] }[] = [];
  const wires: { sessionId: string; prompt: unknown }[] = [];
  const prepare = bridge.driver.prepareSession.bind(bridge.driver);
  const submit = RuntimeSession.prototype.submit;
  const request = Connection.prototype.request;
  const prepareMock = t.mock.method(bridge.driver, "prepareSession", async (input: PrepareDriverInput) => {
    const runtime = await prepare(input);
    assert.ok(runtime.proc instanceof RuntimeSession);
    preparations.set(runtime.proc, runtime.reconstructContext);
    return runtime;
  });
  const submitMock = t.mock.method(RuntimeSession.prototype, "submit", async function (this: RuntimeSession, input: DriverSubmission) {
    submissions.push({ proc: this, messages: structuredClone(input.messages) });
    return submit.call(this, input);
  });
  const requestMock = t.mock.method(Connection.prototype, "request", async function (this: Connection, ...args: Parameters<typeof request>) {
    if (args[0] === "session/prompt") wires.push(structuredClone(args[1]) as { sessionId: string; prompt: unknown });
    return request.apply(this, args);
  });

  try {
    signal.throwIfAborted();
    await session.prompt("Reply READY only. Do not call tools.");
    const old = bridge.liveSessions.get(session.sessionId)?.activeProcess;
    assert.ok(old instanceof RuntimeSession);
    const history = reconstructionHistory(options.model, hidden);
    for (const message of history) session.sessionManager.appendMessage(message);
    session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
    evidence.push({ importedHistory: history, provenance: "test-owned synthetic historical records; not backend execution receipts" });
    const start = submissions.length;
    await session.prompt('Classify the four historical history_probe operations confirmed, failed, cancelled, unresolved using SUCCESS/ERROR/ABORTED/UNKNOWN. Is the exact successful result body known? Do not retry or call tools. Return only JSON with classifications (operation to status), bodyKnown (boolean), retry (false).');
    signal.throwIfAborted();
    const reconstructed = submissions.slice(start)[0];
    assert.ok(reconstructed, "Real Pi provider must submit reconstructed context");
    assert.equal(preparations.get(reconstructed.proc), true);
    assert.notEqual(reconstructed.proc.session.id, old.session.id);
    assert.equal(old.isRunning, false);
    const wire = wires.find(item => item.sessionId === reconstructed.proc.session.id);
    assert.ok(wire, "Actual ACP reconstruction payload observed");
    assert.deepEqual(wire.prompt, serializeContent(reconstructed.messages));
    assert.equal(JSON.stringify(reconstructed.messages).includes(hidden), false, "prepared.hiddenBody: omitted successful result");
    assertReconstructionRecords(serializeContent(reconstructed.messages).filter(part => part.type === "text").map(part => part.text).join("\n"), hidden);
    assertReconstructionRecords((wire.prompt as { type: string; text?: string }[]).map(part => part.text ?? "").join("\n"), hidden);
    assert.equal(executions.length, 0, "Historical operations must never rerun");
    const final = [...session.messages].reverse().find(message => message.role === "assistant");
    assert.ok(final?.role === "assistant");
    assert.equal(final.stopReason, "stop", final.errorMessage ?? "Final turn must complete");
    const text = final.content.filter(part => part.type === "text").map(part => part.text).join("");
    evidence.push({ reconstruction: { oldSessionId: old.session.id, sessionId: reconstructed.proc.session.id, prepared: reconstructed.messages, wire, final, executions } });
    try { assertReconstructionAnswer(text); }
    catch (error) { throw new ScenarioFailure("model", "AGY did not preserve reconstructed history semantics", error); }
  } finally {
    try { await fixture.close(); }
    finally { prepareMock.mock.restore(); submitMock.mock.restore(); requestMock.mock.restore(); }
  }
}
