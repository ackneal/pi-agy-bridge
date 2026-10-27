import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareAcpRuntime } from "./prepare.ts";
import { AcpDriver } from "./driver.ts";
import { useAcpExecutable } from "./executable-fixture.ts";
import { CliRuntimeSession } from "../cli/runtime.ts";
import { LiveSession } from "../../session/session.ts";
import { RuntimeSessionSync } from "../../session/state.ts";

test("ACP clears the previous driver once before checkpoint lookup", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-acp-prepare-"));
  const previousHome = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });
  const live = new LiveSession("test");
  t.after(() => live.dispose());
  const previous = new CliRuntimeSession({ agentName: "pi-bridge", model: "raw" }, new Set(), {});
  live.setSession(previous, "previous-sync");
  const abort = t.mock.method(previous, "abort", async () => {});
  const driver = new AcpDriver();
  useAcpExecutable(t, process.execPath);
  const dispose = t.mock.method(live, "dispose", live.dispose.bind(live));
  const stopped = new Error("Stopped at checkpoint lookup");
  const get = t.mock.fn(async () => {
    assert.equal(dispose.mock.callCount(), 1);
    assert.equal(live.activeProcess, null);
    throw stopped;
  });

  await assert.rejects(driver.prepareSession({
    model: { id: "raw" } as Parameters<typeof prepareAcpRuntime>[0],
    context: { messages: [] }, tools: [], options: undefined, session: live,
    store: { get, delete: async () => {} }, sync: new RuntimeSessionSync(),
    preparationId: live.beginPreparation(),
  }), (error) => error === stopped);

  assert.equal(get.mock.callCount(), 1);
  assert.equal(dispose.mock.callCount(), 1);
  assert.equal(abort.mock.callCount(), 1);
});

test("superseded ACP preparation stops before checkpoint or resource acquisition", async () => {
  const live = new LiveSession("test");
  const stale = live.beginPreparation();
  live.beginPreparation();
  let reads = 0;
  await assert.rejects(prepareAcpRuntime({ id: "raw" } as Parameters<typeof prepareAcpRuntime>[0], { messages: [] }, [], undefined, { cwd: process.cwd(), executable: process.execPath }, {
    store: { get: async () => { reads++; return undefined; }, delete: async () => {} }, sync: new RuntimeSessionSync(), sessionVersion: "acp:v1",
  }, live, stale), /superseded/);
  assert.equal(reads, 0);
  assert.equal(live.activeProcess, null);
});
