import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { RuntimeSessionStore } from "./state.ts";
import { PiContextAdapter } from "./session.ts";

test("legacy login epoch metadata is ignored when recovering compatible checkpoints", async () => {
  const manager = SessionManager.inMemory("/workspace");
  const adapter = new PiContextAdapter();
  const id = adapter.bind(manager);
  const store = new RuntimeSessionStore(adapter);
  const checkpoint = await store.set(id, { sessionId: "conversation-a" }, [], "cli:v1");
  const written = manager.getBranch().at(-1);
  assert.ok(written?.type === "custom");
  assert.equal("loginEpoch" in (written.data as Record<string, unknown>), false);

  manager.appendCustomEntry("pi-agy-bridge.runtime-session", {
    ...checkpoint, loginEpoch: "old-account-epoch",
  });
  assert.deepEqual(await store.get(id, "cli:v1"), checkpoint);
});
