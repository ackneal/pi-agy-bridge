import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { observeLiveAccounting } from "./accounting.ts";
import type { Model } from "@earendil-works/pi-ai";
import { defineTool, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLivePiSession } from "./pi-session.ts";
import { ScenarioFailure } from "./report.ts";

export async function runLiveToolHandoff(options: {
  cwd: string;
  directory: string;
  model: Model<any>;
  launch: { executable: string; args: string[] };
  signal: AbortSignal;
  evidence: unknown[];
  t: TestContext;
  returnError: boolean;
  onToolCall: (call: { id: string; name: string; arguments: unknown }) => void;
}): Promise<void> {
  const expectedValue = randomUUID();
  const toolName = "mcp__pi__live_probe";
  const executions: { id: string; arguments: unknown; marker: string }[] = [];
  const handlerErrors: unknown[] = [];
  const sessionEvents: unknown[] = [];
  let session: AgentSession | undefined;
  const tool = defineTool({
    name: toolName,
    label: "Live tool handoff probe",
    description: "Harmless Pi-owned probe returning a fresh receipt. No filesystem or command access.",
    parameters: Type.Object({ value: Type.String() }),
    async execute(id, args) {
      const execution = { id, arguments: structuredClone(args), marker: `receipt-${randomUUID()}` };
      executions.push(execution);
      options.evidence.push({ piToolExecution: execution });
      try {
        assert.match(id, /^pi_.+$/, "Pi handler must receive the bridge-generated call ID");
        assert.deepEqual(args, { value: expectedValue }, "Pi must execute the exact requested arguments");
        assert.ok(session);
        const calls = session.messages.flatMap(message => message.role === "assistant"
          ? message.content.filter(part => part.type === "toolCall" && part.id === id) : []);
        assert.equal(calls.length, 1, "Handler ID must identify an actual Pi assistant tool call");
        const call = calls[0]!;
        assert.ok(call.type === "toolCall");
        assert.equal(call.id, id);
        assert.equal(call.name, toolName);
        assert.deepEqual(call.arguments, { value: expectedValue });
        options.onToolCall({ id, name: toolName, arguments: structuredClone(args) });
      } catch (error) {
        // Pi converts execute failures into tool results; retain assertion failures separately.
        handlerErrors.push(error);
        throw error;
      }

      if (options.returnError) throw new Error(execution.marker);
      return { content: [{ type: "text", text: execution.marker }], details: { live: true } };
    },
  });
  const accounting = observeLiveAccounting(options.t, options.evidence);
  let fixture: Awaited<ReturnType<typeof createLivePiSession>>;
  try {
    fixture = await createLivePiSession({ ...options, tool });
  } catch (error) {
    accounting.restore();
    throw error;
  }
  session = fixture.session;
  let unsubscribe: (() => void) | undefined;

  try {
    unsubscribe = session.subscribe(event => sessionEvents.push(structuredClone(event)));
    assert.deepEqual(session.getActiveToolNames(), [toolName], "Only the Pi probe may be active");
    options.signal.throwIfAborted();
    try {
      await session.prompt(`Call ${toolName} exactly once with arguments ${JSON.stringify({ value: expectedValue })}. Do not retry or call any tool again, even if the tool returns an error. Then reply with only the exact receipt marker from that result, including on error. Do not invent a receipt.`);
    } finally {
      if (handlerErrors.length) throw handlerErrors[0];
    }
    options.signal.throwIfAborted();

    if (executions.length !== 1) throw new ScenarioFailure("model", `Expected exactly one Pi execution, observed ${executions.length}`);
    const execution = executions[0]!;
    const sessionFile = session.sessionManager.getSessionFile();
    assert.ok(sessionFile, "Pi history must be persisted");
    const branch = SessionManager.open(sessionFile).getBranch();
    options.evidence.push({ persistedPiHistory: branch });
    const messages = branch.flatMap(entry => entry.type === "message" ? [entry.message] : []);
    const calls = messages.flatMap(message => message.role === "assistant"
      ? message.content.filter(part => part.type === "toolCall") : []);
    assert.equal(calls.length, 1, "Persisted history must contain exactly one tool call");
    assert.equal(calls[0]!.id, execution.id);
    assert.equal(calls[0]!.name, toolName);
    assert.deepEqual(calls[0]!.arguments, { value: expectedValue });
    const results = messages.filter(message => message.role === "toolResult");
    assert.equal(results.length, 1, "Persisted history must contain the actual Pi result");
    const result = results[0]!;
    assert.equal(result.toolCallId, execution.id);
    assert.equal(result.toolName, toolName);
    assert.equal(result.isError, options.returnError);
    assert.ok(result.content.some(part => part.type === "text" && part.text.includes(execution.marker)),
      "The handler-only receipt must traverse the real Pi result pipeline");
    const final = messages.at(-1);
    assert.ok(final?.role === "assistant", "The full turn must end with an AGY assistant message");
    assert.equal(final.provider, options.model.provider);
    if (final.stopReason !== "stop") throw new ScenarioFailure("backend", `Pi turn did not complete: ${final.errorMessage ?? final.stopReason}`);
    accounting.assert(session);
    options.evidence.push({ handoffContract: "PASS" });
    if (final.content.filter(part => part.type === "text").map(part => part.text).join("") !== execution.marker) {
      throw new ScenarioFailure("model", "AGY did not return the exact handler-only receipt");
    }
  } catch (error) {
    options.evidence.push({ toolHandoffFailure: String(error) });
    throw error;
  } finally {
    unsubscribe?.();
    try {
      options.evidence.push({ piSessionId: session.sessionId, returnError: options.returnError, expectedValue,
        executions, handlerErrors: handlerErrors.map(String), sessionEvents, piHistory: structuredClone(session.messages),
        piBranch: structuredClone(session.sessionManager.getBranch()) });
    } finally {
      try { await fixture.close(); } finally { accounting.restore(); }
    }
  }
}
