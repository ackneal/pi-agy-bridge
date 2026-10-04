import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { LiveSession, PiContextAdapter } from "./session.ts";
import { RuntimeSessionStore, RuntimeSessionSync } from "./session-state.ts";

for (const scenario of [
  { name: "legacy reference with legacy credential", stored: undefined, current: undefined, accepted: true },
  { name: "matching login epoch", stored: "login-a", current: "login-a", accepted: true },
  { name: "previous login epoch", stored: "login-a", current: "login-b", accepted: false },
  { name: "legacy reference after login", stored: undefined, current: "login-b", accepted: false },
  { name: "epoch reference without matching credential", stored: "login-a", current: undefined, accepted: false },
]) {
  test(`runtime reference: ${scenario.name}`, async () => {
    const manager = SessionManager.inMemory("/workspace");
    const adapter = new PiContextAdapter();
    const id = adapter.bind(manager);
    const store = new RuntimeSessionStore(adapter);
    await store.set(id, { conversationId: "conversation-a" }, [], scenario.stored);

    const restored = await store.get(id, scenario.current);

    assert.equal(restored?.conversationId, scenario.accepted ? "conversation-a" : undefined);
    const decision = new RuntimeSessionSync().decide(new LiveSession(id), {
      syncKey: "model-and-tools", turnIndex: 0, canonicalHistory: [],
      conversationId: "conversation-a", ...(restored ? { runtimeRef: restored } : {}),
    });
    assert.equal(decision.action, scenario.accepted ? "resume" : "rebuild");
  });
}

test("reopening an unattached old session cannot resume its pre-login reference", async () => {
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
  await store.set(current, { conversationId: "old-account-conversation" }, [], "login-a");

  current = "session-b";
  adapter.bind(manager);
  assert.equal(adapter.getSessionManager("session-a"), undefined);
  await store.delete(current);
  current = "session-a";
  adapter.bind(manager);

  assert.equal(await store.get(current, "login-b"), undefined);
  assert.equal((await store.get(current, "login-a"))?.conversationId, "old-account-conversation",
    "epoch validation must not rewrite or destroy old session data");
  await store.set(current, { conversationId: "new-account-conversation" }, [], "login-b");
  assert.equal((await store.get(current, "login-b"))?.conversationId, "new-account-conversation");
});
