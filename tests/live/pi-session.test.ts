import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BridgeIPC } from "../../src/extension/bridge/ipc.ts";
import { Driver as AcpDriver } from "../../src/extension/drivers/acp/driver.ts";
import { SessionMode, type DriverSession, type PrepareDriverInput } from "../../src/extension/drivers/types.ts";
import { Connection as AcpConnection } from "../../src/extension/drivers/acp/connection.ts";
import { createLivePiSession } from "./pi-session.ts";

const model = { id: "gemini-3.1-pro", name: "live", provider: "agy", api: "agy", baseUrl: "agy", reasoning: false,
  input: ["text"], contextWindow: 200_000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<any>;
const tool = defineTool({ name: "mcp__pi__live_probe", label: "Probe", description: "Harmless probe", parameters: Type.Object({ value: Type.String() }),
  execute: async () => ({ content: [{ type: "text", text: "offline fixture" }], details: {} }) });

for (const scenario of ["close", "cancel", "pre-aborted", "broker-cleanup-failure"] as const) {
  test(`real Pi fixture remains offline during initialization: ${scenario}`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), "live-pi-fixture-"));
    const cwd = path.join(root, "project");
    const directory = path.join(root, "fixtures");
    const gemini = path.join(root, "gemini");
    const agentDir = path.join(root, "agent");
    await Promise.all([cwd, directory, gemini, agentDir].map(name => mkdir(name)));
    const sentinel = JSON.stringify({ sentinel: "Do not modify persistent auth" });
    await writeFile(path.join(agentDir, "auth.json"), sentinel);
    const saved = { GEMINI_HOME: process.env.GEMINI_HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, AGY_ACP_DIR: process.env.AGY_ACP_DIR };
    process.env.GEMINI_HOME = gemini;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.AGY_ACP_DIR;
    t.after(async () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    });
    const start = t.mock.method(AcpConnection.prototype, "start", async () => assert.fail("Offline fixture must not start ACP"));
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("Offline fixture must not fetch"));
    const controller = new AbortController();
    const evidence: unknown[] = [];
    const options = { cwd, directory, model, tool, signal: controller.signal, evidence, launch: { executable: "/must-not-run", args: [] } };
    if (scenario === "broker-cleanup-failure") {
      // This is a cleanup-only fixture: neither a subprocess nor a broker is started.
      const broker = new BridgeIPC([]);
      t.mock.method(broker, "close", async () => { throw new Error("Injected broker cleanup failure"); });
      const proc: DriverSession = { driver: "acp", isRunning: false, abort: async () => {},
        onRuntimeEvent: () => () => {}, submit: async () => assert.fail("No cleanup probe submission"),
        serializeContextUpdate: () => { throw new Error("No cleanup probe context"); } };
      t.mock.method(AcpDriver.prototype, "prepareSession", async (_input: PrepareDriverInput) => ({ proc, mcpServer: broker, reconstructContext: true, modelId: model.id }));
      const fixture = await createLivePiSession(options);
      const live = fixture.bridge.liveSessions.getOrCreate(fixture.session.sessionId);
      await fixture.bridge.driver.prepareSession({ model, context: { messages: [] }, messages: [], mode: SessionMode.Conversation, tools: [], options: undefined,
        session: live, preparationId: live.beginPreparation(), store: fixture.bridge.runtimeSessionStore, sync: fixture.bridge.runtimeSessionSync });
      await assert.rejects(fixture.close(), error => error instanceof AggregateError && error.errors.some(item => String(item).includes("Injected broker cleanup failure")));
      assert.ok(evidence.some(item => (item as { piFixtureClosed?: boolean }).piFixtureClosed === false));
      assert.ok(JSON.stringify(evidence).includes("Injected broker cleanup failure"), "Cleanup diagnostics must retain the underlying cause");
    } else if (scenario === "pre-aborted") {
      controller.abort(new Error("Pre-aborted test"));
      await assert.rejects(createLivePiSession(options), /Pre-aborted test/);
    } else {
      const fixture = await createLivePiSession(options);
      t.after(() => fixture.close());
      assert.deepEqual(fixture.session.getActiveToolNames(), [tool.name]);
      assert.equal(fixture.session.settingsManager.getCompactionSettings().enabled, false);
      assert.equal(fixture.session.settingsManager.getCompactionSettings().keepRecentTokens, 1);
      assert.equal(fixture.session.settingsManager.getCacheWarmingMode(), "off");
      assert.equal(fixture.bridge.piContextAdapter.getSessionManager(fixture.session.sessionId), fixture.session.sessionManager);
      const auth = await fixture.session.modelRuntime.getAuth(model);
      assert.equal(auth?.auth.apiKey, "agy-bridge:enabled", "Only the existing synthetic consent marker is resolved");
      if (scenario === "cancel") controller.abort(new Error("Cancel offline fixture"));
      await fixture.close();
      await fixture.close();
      assert.ok(evidence.some(item => (item as { piFixtureClosed?: boolean }).piFixtureClosed === true));
    }
    assert.equal(start.mock.callCount(), 0);
    assert.equal(fetch.mock.callCount(), 0);
    assert.deepEqual(await readdir(directory), [], "Fixture scratch must be removed");
    assert.equal(await readFile(path.join(agentDir, "auth.json"), "utf8"), sentinel, "Authentication Sync must not run");
  });
}
