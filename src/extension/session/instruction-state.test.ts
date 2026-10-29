import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { DriverSession } from "../drivers/types.ts";
import { LiveSession, PiContextAdapter } from "./session.ts";
import { RuntimeSessionStore, RuntimeSessionSync } from "./state.ts";
import { BridgeIPC } from "../bridge/ipc.ts";

const original = "a".repeat(64);
const changed = "b".repeat(64);
const messages = [{ role: "user", content: "question" }];

for (const row of [
  { name: "valid compatibility key", metadata: { compatibilityKey: original }, valid: true },
  { name: "legacy checkpoint", metadata: {}, valid: true },
  { name: "invalid compatibility key", metadata: { compatibilityKey: "invalid" }, valid: false },
]) {
  test(`compatibility metadata: ${row.name}`, async () => {
    const manager = SessionManager.inMemory("/workspace");
    const context = new PiContextAdapter();
    const id = context.bind(manager);
    const store = new RuntimeSessionStore(context);
    const checkpoint = await store.set(id, { sessionId: "conversation", ...row.metadata }, messages, "acp:v1");

    assert.deepEqual(await store.get(id, "acp:v1"), row.valid ? checkpoint : undefined);
    assert.equal(checkpoint.compatibilityKey, row.metadata.compatibilityKey);
  });
}

for (const row of [
  { name: "matching live key continues", live: true, requested: original, expected: "continue" },
  { name: "changed live key rebuilds", live: true, requested: changed, expected: "rebuild" },
  { name: "pending calls cannot defer compatibility changes", live: true, pending: true, requested: changed, expected: "rebuild" },
  { name: "pending calls retain compatible runtime", live: true, pending: true, requested: original, expected: "continue" },
  { name: "missing live key rebuilds when requested", live: true, missingLiveKey: true, requested: original, expected: "rebuild" },
  { name: "compatible checkpoint resumes", checkpoint: original, requested: original, expected: "resume" },
  { name: "changed checkpoint key rebuilds", checkpoint: original, requested: changed, expected: "rebuild" },
  { name: "missing checkpoint key rebuilds when requested", checkpoint: "legacy", requested: original, expected: "rebuild" },
  { name: "caller without requested key resumes a missing-key checkpoint", checkpoint: "legacy", expected: "resume" },
  { name: "caller without requested key resumes after settings change", live: true, changedSettings: true, expected: "resume" },
  { name: "caller without requested key defers settings changes for pending calls", live: true, pending: true, changedSettings: true, expected: "continue" },
]) {
  test(`session compatibility: ${row.name}`, async (t) => {
    const manager = SessionManager.inMemory("/workspace");
    const context = new PiContextAdapter();
    const id = context.bind(manager);
    const store = new RuntimeSessionStore(context);
    const session = new LiveSession(id);
    const sync = new RuntimeSessionSync();
    t.after(() => session.dispose());
    const checkpoint = row.checkpoint ? await store.set(id, {
      sessionId: "conversation",
      ...(row.checkpoint !== "legacy" ? { compatibilityKey: row.checkpoint } : {}),
    }, messages, row.requested ? "acp:v1" : "cli:v1") : undefined;
    if (row.live) {
      const process: DriverSession = {
        driver: row.requested ? "acp" : "cli", isRunning: true,
        ...(row.requested && !("missingLiveKey" in row && row.missingLiveKey) ? { compatibilityKey: original } : {}),
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
      ...(row.requested ? { compatibilityKey: row.requested } : {}),
      ...(checkpoint ? { checkpoint } : {}),
    });

    assert.equal(decision.action, row.expected);
    if (decision.action === "resume") assert.equal(decision.conversationId, "conversation");
  });
}

for (const legacy of [false, true]) {
  test(`stored compatibility schema excludes legacy alias: legacy=${legacy}`, async () => {
    const manager = SessionManager.inMemory("/workspace");
    const context = new PiContextAdapter();
    const id = context.bind(manager);
    const store = new RuntimeSessionStore(context);
    const written = await store.set(id, { sessionId: "conversation", compatibilityKey: original }, messages, "acp:v1");
    const entry = manager.getBranch().at(-1);
    assert.ok(entry?.type === "custom");
    assert.equal(Object.hasOwn(entry.data as object, "instructionKey"), false);
    if (legacy) {
      const { compatibilityKey: _removed, ...metadata } = written;
      manager.appendCustomEntry("pi-agy-bridge.runtime-session", { ...metadata, instructionKey: original });
    }

    const restored = await store.get(id, "acp:v1");
    assert.ok(restored);
    assert.equal(restored.compatibilityKey, legacy ? undefined : original);
    assert.equal(Object.hasOwn(restored, "instructionKey"), false);
    assert.equal(new RuntimeSessionSync().decide(new LiveSession(id), {
      syncKey: "settings", messages, compatibilityKey: original, checkpoint: restored,
    }).action, legacy ? "rebuild" : "resume");
  });
}
