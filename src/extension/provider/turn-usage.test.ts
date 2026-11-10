import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Context, Message, Model, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { CapabilityGateway } from "../bridge/capabilities.ts";
import { BridgeIPC } from "../bridge/ipc.ts";
import type { DriverId, DriverSession, RuntimeEvent } from "../drivers/types.ts";
import { LiveSession } from "../session/session.ts";
import { RuntimeSessionSync } from "../session/state.ts";
import { PiRuntimeOutput } from "./output.ts";
import { Turn } from "./turn.ts";

const model: Model<"agy"> = {
  id: "test-model", name: "Test", api: "agy", provider: "agy", baseUrl: "agy",
  reasoning: true, input: ["text"], contextWindow: 8192, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const selectedModel: Model<"agy"> = {
  ...model, id: "gemini-3.8-flash",
  cost: { input: 2000000, output: 3000000, cacheRead: 5000000, cacheWrite: 7000000 },
};
const tieredModel: Model<"agy"> = {
  ...selectedModel,
  cost: { ...selectedModel.cost, tiers: [
    { inputTokensAbove: 100, input: 4000000, output: 6000000, cacheRead: 10000000, cacheWrite: 14000000 },
  ] },
};

const contextUsage: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 800,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const fullUsage: Usage = {
  input: 100, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: 160,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const cumulativeUsage: Usage = { ...fullUsage, input: 970980, totalTokens: 971000 };
const zeroUsage: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const costUsage: Usage = {
  ...fullUsage, reasoning: 7,
  // Deliberately stale costs must be replaced, not used to select or split rates.
  cost: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999, total: 3996 },
};
const lastCostUsage: Usage = {
  input: 50, output: 12, cacheRead: 15, cacheWrite: 5, reasoning: 4, totalTokens: 82,
  cost: { input: 998, output: 998, cacheRead: 998, cacheWrite: 998, total: 3992 },
};
const pricedUsage: Usage = {
  ...costUsage, cost: { input: 200, output: 60, cacheRead: 150, cacheWrite: 70, total: 480 },
};
const pricedLastUsage: Usage = {
  ...lastCostUsage, cost: { input: 100, output: 36, cacheRead: 75, cacheWrite: 35, total: 246 },
};
const pricedRemainder: Usage = {
  input: 50, output: 8, cacheRead: 15, cacheWrite: 5, reasoning: 3, totalTokens: 78,
  cost: { input: 100, output: 24, cacheRead: 75, cacheWrite: 35, total: 234 },
};

const cases: {
  name: string;
  driver: DriverId;
  accounting: Usage;
  model?: Model<"agy">;
  lastCallUsage?: Usage;
  standalone?: boolean;
  handoff?: boolean;
  initialContext?: null;
  zeroSnapshotAfter?: boolean;
  expectedUsage: Usage;
  expectedAccounting: Usage[];
}[] = [
  { name: "CLI zero accounting preserves context usage", driver: "cli", accounting: zeroUsage,
    expectedUsage: contextUsage, expectedAccounting: [] },
  { name: "CLI negative accounting preserves context usage", driver: "cli", accounting: { ...zeroUsage, totalTokens: -1 },
    expectedUsage: contextUsage, expectedAccounting: [] },
  { name: "CLI zero total still records nonzero accounting components", driver: "cli", accounting: { ...fullUsage, totalTokens: 0 },
    expectedUsage: contextUsage, expectedAccounting: [{ ...fullUsage, totalTokens: 0 }] },
  { name: "CLI open assistant keeps context-only usage and records accounting once", driver: "cli", accounting: fullUsage,
    expectedUsage: contextUsage, expectedAccounting: [fullUsage] },
  { name: "CLI missing context snapshot stays zero despite cumulative accounting", driver: "cli", accounting: cumulativeUsage, initialContext: null,
    expectedUsage: zeroUsage, expectedAccounting: [cumulativeUsage] },
  { name: "CLI cumulative response of 971000 never overwrites context snapshot of 800", driver: "cli", accounting: cumulativeUsage,
    expectedUsage: contextUsage, expectedAccounting: [cumulativeUsage] },
  { name: "CLI zero snapshot preserves current context usage", driver: "cli", accounting: fullUsage, zeroSnapshotAfter: true,
    expectedUsage: contextUsage, expectedAccounting: [fullUsage] },
  { name: "CLI zero snapshot without prior context stays zero", driver: "cli", accounting: cumulativeUsage,
    initialContext: null, zeroSnapshotAfter: true, expectedUsage: zeroUsage, expectedAccounting: [cumulativeUsage] },
  { name: "CLI tool handoff routes late usage to accounting once", driver: "cli", accounting: fullUsage, handoff: true,
    expectedUsage: contextUsage, expectedAccounting: [fullUsage] },
  { name: "CLI tool handoff ignores late zero accounting", driver: "cli", accounting: zeroUsage, handoff: true,
    expectedUsage: contextUsage, expectedAccounting: [] },
  { name: "ACP open assistant keeps context and separate accounting", driver: "acp", accounting: fullUsage,
    expectedUsage: contextUsage, expectedAccounting: [fullUsage] },
  { name: "ACP tool handoff keeps late accounting separate", driver: "acp", accounting: fullUsage, handoff: true,
    expectedUsage: contextUsage, expectedAccounting: [fullUsage] },
  ...(["cli", "acp"] as const).flatMap((driver) => [
    { name: `${driver} selected rates replace stale costs with cache and reasoning priced once`, driver,
      model: selectedModel, accounting: costUsage, expectedUsage: contextUsage, expectedAccounting: [pricedUsage] },
    { name: `${driver} context-only event retains zero costs with nonzero selected rates`, driver,
      model: selectedModel, accounting: zeroUsage,
      expectedUsage: contextUsage, expectedAccounting: driver === "cli" ? [] : [zeroUsage] },
    { name: `${driver} priced single call has no separate remainder`, driver,
      model: selectedModel, accounting: costUsage, lastCallUsage: costUsage,
      expectedUsage: pricedUsage, expectedAccounting: [] },
    { name: `${driver} split prices last call and remainder independently of stale costs and aggregate tier`, driver,
      model: tieredModel, accounting: costUsage, lastCallUsage: lastCostUsage,
      expectedUsage: pricedLastUsage, expectedAccounting: [pricedRemainder] },
    { name: `${driver} missing snapshot prices full separate accounting`, driver,
      model: selectedModel, accounting: costUsage, initialContext: null,
      expectedUsage: zeroUsage, expectedAccounting: [pricedUsage] },
    { name: `${driver} invalid snapshot prices full separate accounting`, driver,
      model: selectedModel, accounting: costUsage, lastCallUsage: cumulativeUsage,
      expectedUsage: contextUsage, expectedAccounting: [pricedUsage] },
    { name: `${driver} late handoff prices whole accounting exactly once despite snapshot`, driver,
      model: selectedModel, accounting: costUsage, lastCallUsage: lastCostUsage, handoff: true,
      expectedUsage: contextUsage, expectedAccounting: [pricedUsage] },
    { name: `${driver} standalone summary without accounting callback prices whole prompt`, driver,
      model: selectedModel, accounting: costUsage, lastCallUsage: lastCostUsage, standalone: true,
      expectedUsage: pricedUsage, expectedAccounting: [] },
    { name: `${driver} standalone summary without snapshot prices whole prompt`, driver,
      model: selectedModel, accounting: costUsage, standalone: true,
      expectedUsage: pricedUsage, expectedAccounting: [] },
    { name: `${driver} single-call snapshot needs no separate accounting`, driver, accounting: fullUsage, lastCallUsage: fullUsage,
      expectedUsage: fullUsage, expectedAccounting: [] },
    { name: `${driver} multi-call snapshot splits context from earlier calls`, driver,
      accounting: { ...zeroUsage, input: 14490, output: 865, totalTokens: 15355 },
      lastCallUsage: { ...zeroUsage, input: 8461, output: 734, totalTokens: 9195 },
      expectedUsage: { ...zeroUsage, input: 8461, output: 734, totalTokens: 9195 },
      expectedAccounting: [{ ...zeroUsage, input: 6029, output: 131, totalTokens: 6160 }] },
    { name: `${driver} invalid snapshot leaves whole accounting separate`, driver, accounting: fullUsage, lastCallUsage: cumulativeUsage,
      expectedUsage: contextUsage, expectedAccounting: [fullUsage] },
    { name: `${driver} closed writer accounts whole prompt despite snapshot`, driver, accounting: fullUsage, lastCallUsage: fullUsage, handoff: true,
      expectedUsage: contextUsage, expectedAccounting: [fullUsage] },
    { name: `${driver} standalone summary returns whole prompt usage`, driver, accounting: fullUsage, lastCallUsage: fullUsage, standalone: true,
      expectedUsage: fullUsage, expectedAccounting: [] },
  ]),
];

for (const row of cases) {
  test(`Turn usage: ${row.name}`, async (t) => {
    const requestModel = row.model ?? model;
    const driverUsage = structuredClone(row.accounting);
    const driverLastCallUsage = row.lastCallUsage && structuredClone(row.lastCallUsage);
    const driverContextUsage = structuredClone(contextUsage);
    const originalInputs = structuredClone({ driverUsage, driverLastCallUsage, driverContextUsage });
    const listeners = new Set<(event: RuntimeEvent) => void>();
    const proc: DriverSession = {
      driver: row.driver,
      isRunning: true,
      onRuntimeEvent(handler) {
        listeners.add(handler);
        return () => { listeners.delete(handler); };
      },
      serializeContextUpdate: () => "",
      submit: async () => { assert.fail("These tests deliver runtime events, not native input"); },
      abort: async () => {},
    };
    const emit = (event: RuntimeEvent) => {
      assert.equal(listeners.size, 1, "exactly one Turn owns runtime output");
      for (const listener of listeners) listener(event);
    };
    const session = new LiveSession(`turn-usage-${row.name}`);
    const tools = [{ name: "read", description: "Read", parameters: Type.Object({}) }];
    const bridge = new BridgeIPC(tools);
    const gateway = new CapabilityGateway(tools);
    t.mock.getter(bridge, "hasPendingCalls", () => gateway.hasPendingCalls);
    t.mock.method(bridge, "setToolCallHandler", gateway.setToolCallHandler.bind(gateway));
    t.mock.method(bridge, "resolveToolResults", gateway.resolveToolResults.bind(gateway));
    t.after(() => gateway.cancelPendingCalls("Test finished"));
    t.after(() => session.dispose());
    const sync = new RuntimeSessionSync();
    const accounting: Usage[] = [];
    const context: Context = { messages: [{ role: "user", content: "Read and answer", timestamp: 1 }] };
    const attach = (adapter: PiRuntimeOutput, turnContext: Context) => {
      const preparationId = session.beginPreparation();
      assert.equal(session.setSession(proc, "usage-test", bridge, "native-session", preparationId), true);
      const turn = new Turn({
        session, adapter, model: requestModel, context: turnContext, sync, store: undefined, preparationId,
        signal: undefined, sessionVersion: "test",
        ...(!row.standalone ? { onAccounting: (usage: Usage) => { accounting.push(usage); } } : {}),
      });
      turn.attach({ proc, mcpServer: bridge });
      turn.openToolDispatch();
      return turn;
    };
    const output = new PiRuntimeOutput({ model: requestModel.id, allowedToolNames: new Set(["read"]) });
    attach(output, context);
    emit({ type: "session-reference", reference: "native-session" });
    if (row.initialContext !== null) emit({ type: "usage", usage: driverContextUsage });
    emit({ type: "text-delta", delta: "Reading" });

    let toolResult: Extract<Message, { role: "toolResult" }> | undefined;
    let pendingResult: Promise<unknown> | undefined;
    if (row.handoff) {
      pendingResult = gateway.call("read", {});
      // Keep cleanup failures from becoming unhandled rejections if an assertion fails.
      void pendingResult.catch(() => {});
      const handoff = await output.stream.result();
      const call = handoff.content.find((block) => block.type === "toolCall");
      assert.ok(call);
      assert.equal(call.name, "read");
      assert.equal(handoff.stopReason, "toolUse");
      assert.equal(bridge.hasPendingCalls, true);
      assert.equal(listeners.size, 1, "handoff retains its event handler for late accounting");
      toolResult = {
        role: "toolResult", toolCallId: call.id, toolName: call.name,
        content: [{ type: "text", text: "Read result" }], isError: false, timestamp: 2,
      };
    }

    emit({ type: "accounting", usage: driverUsage, ...(driverLastCallUsage ? { lastCallUsage: driverLastCallUsage } : {}) });
    if (row.zeroSnapshotAfter) emit({ type: "usage", usage: zeroUsage });
    assert.deepEqual(accounting, row.expectedAccounting);
    if (!row.handoff) emit({ type: "complete", reason: "stop", resumable: true });
    const saved: AssistantMessage = await output.stream.result();
    assert.deepEqual(saved.usage, row.expectedUsage, "saved usage matches the last call or summary, never the cumulative conversation prompt");
    assert.equal(saved.responseId, "native-session");
    assert.equal(saved.model, requestModel.id);
    assert.equal(saved.stopReason, row.handoff ? "toolUse" : "stop");
    assert.deepEqual(saved.content[0], { type: "text", text: "Reading" });
    assert.deepEqual(output.message.usage, saved.usage, "writer and saved message retain the same usage");
    assert.equal(sync.getSyncedMessageCount(session), context.messages.length + 1);

    if (toolResult) {
      assert.equal(bridge.resolveToolResults([toolResult]), 1);
      await pendingResult;
    }

    assert.deepEqual(accounting, row.expectedAccounting, "no duplicate accounting after completion or tool results");
    assert.equal(bridge.hasPendingCalls, false);
    assert.equal(session.activeProcess, proc);
    assert.deepEqual({ driverUsage, driverLastCallUsage, driverContextUsage }, originalInputs, "driver usage and nested costs are not mutated");
  });
}
