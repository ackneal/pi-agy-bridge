import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { DriverSession } from "../drivers/types.ts";
import { LiveSession, PiContextAdapter } from "./session.ts";
import { RuntimeSessionStore, RuntimeSessionSync } from "./session-state.ts";
import { BridgeIPC } from "../bridge/bridge-ipc.ts";

const original = "a".repeat(64);
const changed = "b".repeat(64);
const messages = [{ role: "user", content: "question" }];

for (const row of [
  { name: "ACP checkpoint", metadata: { instructionKey: original }, valid: true },
  { name: "legacy checkpoint", metadata: {}, valid: true },
  { name: "invalid instruction key", metadata: { instructionKey: "invalid" }, valid: false },
]) {
  test(`instruction metadata: ${row.name}`, async () => {
    const manager = SessionManager.inMemory("/workspace");
    const context = new PiContextAdapter();
    const id = context.bind(manager);
    const store = new RuntimeSessionStore(context);
    const checkpoint = await store.set(id, { sessionId: "conversation", ...row.metadata }, messages, undefined, "acp:v1");

    assert.deepEqual(await store.get(id, undefined, "acp:v1"), row.valid ? checkpoint : undefined);
    assert.equal(checkpoint.instructionKey, row.metadata.instructionKey);
  });
}

for (const row of [
  { name: "same live instructions continue", live: true, requested: original, expected: "continue" },
  { name: "changed live instructions rebuild", live: true, requested: changed, expected: "rebuild" },
  { name: "pending calls cannot defer instruction changes", live: true, pending: true, requested: changed, expected: "rebuild" },
  { name: "pending calls keep compatible instructions", live: true, pending: true, requested: original, expected: "continue" },
  { name: "compatible checkpoint resumes", checkpoint: original, requested: original, expected: "resume" },
  { name: "changed checkpoint instructions rebuild", checkpoint: original, requested: changed, expected: "rebuild" },
  { name: "legacy ACP checkpoint rebuilds", checkpoint: "legacy", requested: original, expected: "rebuild" },
  { name: "CLI legacy checkpoint still resumes", checkpoint: "legacy", expected: "resume" },
  { name: "CLI settings change still resumes", live: true, changedSettings: true, expected: "resume" },
  { name: "CLI pending calls still defer settings changes", live: true, pending: true, changedSettings: true, expected: "continue" },
]) {
  test(`instruction compatibility: ${row.name}`, async (t) => {
    const manager = SessionManager.inMemory("/workspace");
    const context = new PiContextAdapter();
    const id = context.bind(manager);
    const store = new RuntimeSessionStore(context);
    const session = new LiveSession(id);
    const sync = new RuntimeSessionSync();
    t.after(() => session.dispose());
    const checkpoint = row.checkpoint ? await store.set(id, {
      sessionId: "conversation",
      ...(row.checkpoint !== "legacy" ? { instructionKey: row.checkpoint } : {}),
    }, messages, undefined, row.requested ? "acp:v1" : "cli:v1") : undefined;
    if (row.live) {
      const process: DriverSession = {
        driver: row.requested ? "acp" : "cli", isRunning: true,
        ...(row.requested ? { instructionKey: original } : {}),
        onRuntimeEvent: () => () => {}, formatContextUpdate: () => "",
        submit: async () => {}, abort: async () => {},
      };
      const mcp = new BridgeIPC([], session.id, session.resources);
      t.mock.getter(mcp, "hasPendingCalls", () => row.pending ?? false);
      session.setSession(process, "settings", mcp, "conversation");
      sync.record(session, messages);
    }

    const decision = sync.decide(session, {
      syncKey: row.changedSettings ? "other-settings" : "settings",
      messages,
      ...(row.requested ? { instructionKey: row.requested } : {}),
      ...(checkpoint ? { checkpoint } : {}),
    });

    assert.equal(decision.action, row.expected);
    if (decision.action === "resume") assert.equal(decision.conversationId, "conversation");
  });
}
