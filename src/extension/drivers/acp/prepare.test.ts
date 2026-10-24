import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareAcpRuntime } from "./prepare.ts";
import { LiveSession } from "../../session/session.ts";
import { RuntimeSessionSync } from "../../session/session-state.ts";

test("superseded ACP preparation stops before checkpoint or resource acquisition", async () => {
  const live = new LiveSession("test");
  const stale = live.beginPreparation();
  live.beginPreparation();
  let reads = 0;
  await assert.rejects(prepareAcpRuntime({ id: "raw" } as Parameters<typeof prepareAcpRuntime>[0], { messages: [] }, [], undefined, undefined, {
    store: { get: async () => { reads++; return undefined; }, delete: async () => {} }, sync: new RuntimeSessionSync(), sessionVersion: "acp:v1",
  }, live, stale), /superseded/);
  assert.equal(reads, 0);
  assert.equal(live.activeProcess, null);
});
