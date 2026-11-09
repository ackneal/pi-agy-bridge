import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Context, Message, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { CapabilityGateway } from "../bridge/capabilities.ts";
import { BridgeIPC } from "../bridge/ipc.ts";
import type { DriverId, DriverSession, RuntimeEvent } from "../drivers/types.ts";
import { LiveSession } from "../session/session.ts";
import { RuntimeSessionSync } from "../session/state.ts";
import { PiRuntimeOutput } from "./output.ts";
import { Turn } from "./turn.ts";

const contextUsage: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 800,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const fullUsage: Usage = {
  input: 100, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: 160,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.01, total: 0.34 },
};
const cumulativeUsage: Usage = { ...fullUsage, input: 970980, totalTokens: 971000 };
const zeroUsage: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const cases: {
  name: string;
  driver: DriverId;
  accounting: Usage;
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
        session, adapter, context: turnContext, sync, store: undefined, preparationId,
        signal: undefined, sessionVersion: "test",
        ...(!row.standalone ? { onAccounting: (usage: Usage) => { accounting.push(usage); } } : {}),
      });
      turn.attach({ proc, mcpServer: bridge });
      turn.openToolDispatch();
      return turn;
    };
    const output = new PiRuntimeOutput({ model: "test-model", allowedToolNames: new Set(["read"]) });
    attach(output, context);
    emit({ type: "session-reference", reference: "native-session" });
    if (row.initialContext !== null) emit({ type: "usage", usage: contextUsage });
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

    emit({ type: "accounting", usage: row.accounting, ...(row.lastCallUsage ? { lastCallUsage: row.lastCallUsage } : {}) });
    if (row.zeroSnapshotAfter) emit({ type: "usage", usage: zeroUsage });
    assert.deepEqual(accounting, row.expectedAccounting);
    if (!row.handoff) emit({ type: "complete", reason: "stop", resumable: true });
    const saved: AssistantMessage = await output.stream.result();
    assert.deepEqual(saved.usage, row.expectedUsage, "saved usage matches the last call or summary, never the cumulative conversation prompt");
    assert.equal(saved.responseId, "native-session");
    assert.equal(saved.model, "test-model");
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
  });
}
