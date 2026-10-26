import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { LiveSession, PiContextAdapter } from "./session.ts";
import { RuntimeSessionStore, RuntimeSessionSync } from "./state.ts";

for (const scenario of [
  { name: "checkpoint and credential without login epochs", stored: undefined, current: undefined, accepted: true },
  { name: "matching login epoch", stored: "login-a", current: "login-a", accepted: true },
  { name: "previous login epoch", stored: "login-a", current: "login-b", accepted: false },
  { name: "checkpoint without epoch after login", stored: undefined, current: "login-b", accepted: false },
  { name: "checkpoint epoch without matching credential", stored: "login-a", current: undefined, accepted: false },
]) {
  test(`conversation checkpoint: ${scenario.name}`, async () => {
    const manager = SessionManager.inMemory("/workspace");
    const adapter = new PiContextAdapter();
    const id = adapter.bind(manager);
    const store = new RuntimeSessionStore(adapter);
    await store.set(id, { sessionId: "conversation-a" }, [], scenario.stored, "cli:v1");

    const restored = await store.get(id, scenario.current, "cli:v1");

    assert.equal(restored?.sessionId, scenario.accepted ? "conversation-a" : undefined);
    const decision = new RuntimeSessionSync().decide(new LiveSession(id), {
      syncKey: "model-and-tools", messages: [],
      conversationId: "conversation-a", ...(restored ? { checkpoint: restored } : {}),
    });
    assert.equal(decision.action, scenario.accepted ? "resume" : "rebuild");
  });
}

test("reopening an unattached old session cannot resume its pre-login checkpoint", async () => {
  let current = "session-a";
  let serial = 0;
  const branches = new Map<string, Array<{ type: "custom"; id: string; customType: string; data: unknown }>>([
    ["session-a", []], ["session-b", []],
  ]);
  const manager = {
    getSessionId: () => current,
    getBranch: () => branches.get(current)!,
    appendCustomEntry(customType: string, data: unknown) {
      const id = String(++serial);
      branches.get(current)!.push({ type: "custom", id, customType, data });
      return id;
    },
  } as unknown as SessionManager;
  const adapter = new PiContextAdapter();
  const store = new RuntimeSessionStore(adapter);
  adapter.bind(manager);
  await store.set(current, { sessionId: "old-account-conversation" }, [], "login-a", "cli:v1");

  current = "session-b";
  adapter.bind(manager);
  assert.equal(adapter.getSessionManager("session-a"), undefined);
  await store.delete(current);
  current = "session-a";
  adapter.bind(manager);

  assert.equal(await store.get(current, "login-b", "cli:v1"), undefined);
  assert.equal((await store.get(current, "login-a", "cli:v1"))?.sessionId, "old-account-conversation",
    "epoch validation must not rewrite or destroy old session data");
  await store.set(current, { sessionId: "new-account-conversation" }, [], "login-b", "cli:v1");
  assert.equal((await store.get(current, "login-b", "cli:v1"))?.sessionId, "new-account-conversation");
});
