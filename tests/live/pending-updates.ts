import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { defineTool, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CapabilityGateway, type McpToolResult } from "../../src/extension/bridge/capabilities.ts";
import { BridgeIPC } from "../../src/extension/bridge/ipc.ts";
import { createLivePiSession } from "./pi-session.ts";
import { observeLiveAccounting, type LiveUsageOptions } from "./accounting.ts";
import { ScenarioFailure } from "./report.ts";

export function waitForRelease(released: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    released.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function runLivePendingUpdates(options: LiveUsageOptions & {
  returnError: boolean;
  onToolCall: (call: { id: string; name: string; arguments: unknown }) => void;
}): Promise<void> {
  const observer = observeLiveAccounting(options.t, options.evidence);
  const toolName = "mcp__pi__pending_probe";
  const value = randomUUID();
  const correction = `corrected-${randomUUID()}`;
  const receipts: string[] = [];
  const results: McpToolResult[] = [];
  const gateways = new Set<CapabilityGateway>();
  const errors: unknown[] = [];
  let session: AgentSession | undefined;
  let fixture: Awaited<ReturnType<typeof createLivePiSession>> | undefined;
  let prompting: Promise<void> | undefined;
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const executing = new Promise<void>(resolve => { entered = resolve; });
  const call = CapabilityGateway.prototype.call;
  const resolveResults = BridgeIPC.prototype.resolveToolResults;
  const callMock = options.t.mock.method(CapabilityGateway.prototype, "call", async function(this: CapabilityGateway, ...args: Parameters<typeof call>) {
    gateways.add(this);
    const result = await call.apply(this, args);
    results.push(structuredClone(result));
    options.evidence.push({ genuineMcpResult: result });
    return result;
  });
  const boundaries: { pending: boolean; active: boolean; appendix: string | undefined; resolved: number }[] = [];
  const resolveMock = options.t.mock.method(BridgeIPC.prototype, "resolveToolResults", function(this: BridgeIPC, ...args: Parameters<typeof resolveResults>) {
    const pending = this.hasPendingCalls;
    const active = observer.prompts.length === 1 && observer.prompts[0]!.hasActivePrompt;
    const resolved = resolveResults.apply(this, args);
    boundaries.push({ pending, active, appendix: args[1], resolved });
    return resolved;
  });

  try {
    const tool = defineTool({ name: toolName, label: "Pending steering probe", description: "Harmless held probe returning a fresh receipt.", parameters: Type.Object({ value: Type.String() }),
      async execute(id, args) {
        try {
          assert.ok(session);
          assert.equal(receipts.length, 0, "Steering must not cause a second tool execution");
          assert.deepEqual(args, { value });
          assert.match(id, /^pi_.+/);
          const calls = session.messages.flatMap(message => message.role === "assistant" ? message.content.filter(part => part.type === "toolCall" && part.id === id) : []);
          assert.equal(calls.length, 1);
          assert.equal(calls[0]!.type === "toolCall" && calls[0]!.name, toolName);
          const receipt = `receipt-${randomUUID()}`;
          receipts.push(receipt);
          options.onToolCall({ id, name: toolName, arguments: structuredClone(args) });
          assert.equal(observer.prompts.length, 1);
          assert.equal(observer.prompts[0]!.hasActivePrompt, true);
          assert.ok([...gateways].some(gateway => gateway.hasPendingCalls), "Steering must occur while an actual MCP call is pending");
          entered();
          await waitForRelease(released, options.signal);
          if (options.returnError) throw new Error(receipt);
          return { content: [{ type: "text", text: receipt }], details: { live: true } };
        } catch (error) {
          if (!(options.returnError && error instanceof Error && error.message === receipts[0])) errors.push(error);
          throw error;
        }
      } });
    fixture = await createLivePiSession({ ...options, tool });
    session = fixture.session;
    options.signal.throwIfAborted();
    prompting = session.prompt(`Call ${toolName} exactly once with ${JSON.stringify({ value })}. Do not retry, even on error. Then reply with only the exact tool receipt.`);
    // Cleanup still owns this prompt if steering or the held-boundary wait fails.
    void prompting.catch(() => {});
    await Promise.race([
      waitForRelease(executing, options.signal),
      prompting.then(() => { throw new Error("Pi completed without reaching the held tool execution"); }),
    ]);
    assert.equal(observer.prompts[0]!.hasActivePrompt, true);
    assert.ok([...gateways].some(gateway => gateway.hasPendingCalls));
    const disposition = await session.steer(`Fresh user correction: ignore the earlier final-answer format. Do not call any more tools, even on error. Reply with exactly ${correction} followed by one space and the exact receipt from the pending tool result. Do not invent the receipt.`);
    assert.equal(disposition, "queued", "Correction must enter Pi's supported steering queue");
    release();
    await prompting;
    options.signal.throwIfAborted();
    if (errors.length) throw errors[0];
    assert.equal(receipts.length, 1);
    assert.equal(results.length, 1, "Must observe the real MCP reply, not a fabricated submission");
    assert.equal(results[0]!.isError, options.returnError);
    assert.ok(results[0]!.content.some(part => part.type === "text" && part.text.includes(receipts[0]!)));
    assert.ok(results[0]!.content.some(part => part.type === "text" && part.text.startsWith("# Pending conversation updates (separate from tool output)") && part.text.includes(correction)), "Actual MCP result appendix must carry the fresh user correction");
    assert.equal(boundaries.length, 1);
    assert.deepEqual([boundaries[0]!.pending, boundaries[0]!.active, boundaries[0]!.resolved], [true, true, 1]);
    assert.ok(boundaries[0]!.appendix?.includes(correction));
    const file = session.sessionManager.getSessionFile();
    assert.ok(file);
    const messages = SessionManager.open(file).getBranch().flatMap(entry => entry.type === "message" ? [entry.message] : []);
    assert.equal(messages.flatMap(message => message.role === "assistant" ? message.content.filter(part => part.type === "toolCall") : []).length, 1);
    const result = messages.filter(message => message.role === "toolResult");
    assert.equal(result.length, 1);
    assert.equal(result[0]!.isError, options.returnError);
    const final = messages.at(-1);
    assert.ok(final?.role === "assistant");
    if (final.stopReason !== "stop") throw new ScenarioFailure("backend", `Pending-update turn did not complete: ${final.errorMessage ?? final.stopReason}`);
    observer.assert(session);
    options.evidence.push({ pendingUpdateContract: "PASS", finalAssistant: final });
    if (final.content.filter(part => part.type === "text").map(part => part.text).join("") !== `${correction} ${receipts[0]}`) {
      throw new ScenarioFailure("model", "AGY did not apply the user correction and preserve the handler-only receipt");
    }
  } finally {
    entered();
    release();
    options.evidence.push({ pendingBoundaries: boundaries, receipts, handlerErrors: errors.map(String), piHistory: session?.messages });
    try { await fixture?.close(); } finally {
      await Promise.allSettled(prompting ? [prompting] : []);
      resolveMock.mock.restore();
      callMock.mock.restore();
      observer.restore();
    }
  }
}
