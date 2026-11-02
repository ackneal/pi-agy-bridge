import assert from "node:assert/strict";
import type { PromptResponse } from "@agentclientprotocol/sdk/unstable";
import type { TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import { defineTool, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Session } from "../../src/extension/drivers/acp/session.ts";
import { EventProcessor } from "../../src/extension/drivers/acp/events.ts";
import { RuntimeSession } from "../../src/extension/drivers/acp/runtime.ts";
import type { RuntimeEvent } from "../../src/extension/drivers/types.ts";
import { createLivePiSession } from "./pi-session.ts";
import { ScenarioFailure } from "./report.ts";

export interface LiveUsageOptions {
  cwd: string;
  directory: string;
  model: Model<any>;
  launch: { executable: string; args: string[] };
  signal: AbortSignal;
  t: TestContext;
  evidence: unknown[];
}

const counters = ["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens", "thoughtTokens", "totalTokens"] as const;
type Counters = Partial<Record<typeof counters[number], number>>;
const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

// Independent contract oracle: backend input includes cached tokens; thoughts are
// additional output only if the reported total establishes that interpretation.
export function expectedAccounting(raw: Counters) {
  if (!valid(raw.inputTokens) || !valid(raw.outputTokens)) return undefined;
  const read = valid(raw.cachedReadTokens) ? raw.cachedReadTokens : 0;
  const write = valid(raw.cachedWriteTokens) ? raw.cachedWriteTokens : 0;
  const thoughts = valid(raw.thoughtTokens) ? raw.thoughtTokens : undefined;
  const output = raw.outputTokens + (thoughts !== undefined && raw.totalTokens === raw.inputTokens + raw.outputTokens + thoughts ? thoughts : 0);
  const input = Math.max(0, raw.inputTokens - read - write);
  return { input, output, cacheRead: read, cacheWrite: write,
    ...(thoughts !== undefined ? { reasoning: thoughts } : {}),
    totalTokens: input + output + read + write,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function observeLiveAccounting(t: TestContext, evidence: unknown[]) {
  const prompts: Session[] = [];
  const responses: Counters[] = [];
  const occupancy: number[] = [];
  const events: RuntimeEvent[] = [];
  const prompt = Session.prototype.prompt;
  const process = EventProcessor.prototype.process;
  const subscribe = RuntimeSession.prototype.onRuntimeEvent;
  const promptMock = t.mock.method(Session.prototype, "prompt", async function(this: Session, ...args: Parameters<typeof prompt>) {
    prompts.push(this);
    const response = await prompt.apply(this, args);
    const raw: Counters = {};
    for (const key of counters) {
      const value = (response as PromptResponse).usage?.[key];
      if (value !== undefined && value !== null) raw[key] = value;
    }
    responses.push(raw);
    // Store allowlisted names as values: the report intentionally redacts object
    // keys containing "token" to protect credentials.
    evidence.push({ nativePromptResponse: { stopReason: response.stopReason,
      counters: counters.flatMap(counter => raw[counter] === undefined ? [] : [{ counter, value: raw[counter] }]) } });
    return response;
  });
  const processMock = t.mock.method(EventProcessor.prototype, "process", function(this: EventProcessor, ...args: Parameters<typeof process>) {
    const [notification, source] = args;
    if (source === "live" && notification.update.sessionUpdate === "usage_update") {
      const { used, size } = notification.update;
      evidence.push({ nativeUsageUpdate: { used, size } });
      if (valid(used)) occupancy.push(used);
    }
    return process.apply(this, args);
  });
  const seen = new Set<RuntimeEvent>();
  const subscribeMock = t.mock.method(RuntimeSession.prototype, "onRuntimeEvent", function(this: RuntimeSession, handler: Parameters<typeof subscribe>[0]) {
    return subscribe.call(this, event => {
      if (!seen.has(event)) {
        seen.add(event);
        events.push(structuredClone(event));
      }
      handler(event);
    });
  });

  return {
    prompts,
    assert(session: AgentSession) {
      assert.equal(prompts.length, 1, "Exactly one real native prompt is required");
      assert.equal(responses.length, 1, "Native prompt must complete");
      const expected = expectedAccounting(responses[0]!);
      if (!expected) throw new ScenarioFailure("backend", "Backend supplied no valid billable usage; compatibility is unproven");
      const accounting = events.filter(event => event.type === "accounting");
      assert.equal(accounting.length, 1);
      assert.deepEqual(accounting[0]!.usage, expected);
      const file = session.sessionManager.getSessionFile();
      assert.ok(file);
      const entries = SessionManager.open(file).getBranch().filter(entry => entry.type === "usage" && entry.kind === "agy_turn");
      assert.equal(entries.length, prompts.length, "Persist agy_turn exactly once per native prompt");
      const entry = entries[0]!;
      assert.ok(entry.type === "usage");
      assert.deepEqual(entry.usage, expected);
      if (!occupancy.length) throw new ScenarioFailure("backend", "Backend supplied no valid context usage_update; compatibility is unproven");
      const latest = occupancy.at(-1)!;
      const context = events.filter(event => event.type === "usage");
      assert.equal(context.at(-1)?.usage.totalTokens, latest);
      const final = session.messages.at(-1);
      assert.ok(final?.role === "assistant");
      assert.equal(entry.provider, final.provider);
      assert.equal(entry.model, final.model);
      evidence.push({ persistedPiUsage: entry, finalAssistantUsage: final.usage });
      assert.deepEqual([final.usage.input, final.usage.output, final.usage.cacheRead, final.usage.cacheWrite], [0, 0, 0, 0]);
      assert.equal(final.usage.totalTokens, latest, "Latest occupancy must reach final assistant independently of billing");
    },
    restore() {
      evidence.push({ runtimeUsageEvents: events.filter(event => event.type === "usage" || event.type === "accounting") });
      subscribeMock.mock.restore();
      processMock.mock.restore();
      promptMock.mock.restore();
    },
  };
}

export async function runLiveUsage(options: LiveUsageOptions): Promise<void> {
  const observer = observeLiveAccounting(options.t, options.evidence);
  let fixture: Awaited<ReturnType<typeof createLivePiSession>> | undefined;
  let executions = 0;
  try {
    const tool = defineTool({ name: "mcp__pi__unused_usage_probe", label: "Unused probe", description: "Do not call this tool.", parameters: Type.Object({}),
      async execute() { executions++; throw new Error("No-tool usage scenario executed a tool"); } });
    fixture = await createLivePiSession({ ...options, tool });
    const marker = randomUUID();
    options.signal.throwIfAborted();
    await fixture.session.prompt(`Do not use any tools. Reply with exactly: ${marker}`);
    options.signal.throwIfAborted();
    assert.equal(executions, 0);
    const final = fixture.session.messages.at(-1);
    assert.ok(final?.role === "assistant");
    if (final.stopReason !== "stop") throw new ScenarioFailure("backend", `Usage turn did not complete: ${final.errorMessage ?? final.stopReason}`);
    observer.assert(fixture.session);
    options.evidence.push({ usageContract: "PASS", finalAssistant: final });
    if (final.content.filter(part => part.type === "text").map(part => part.text).join("") !== marker) {
      throw new ScenarioFailure("model", "AGY did not return the requested no-tool marker");
    }
  } finally {
    try { await fixture?.close(); } finally { observer.restore(); }
  }
}
