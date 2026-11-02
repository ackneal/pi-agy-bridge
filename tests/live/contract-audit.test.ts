import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Session } from "../../src/extension/drivers/acp/session.ts";
import { EventProcessor } from "../../src/extension/drivers/acp/events.ts";
import { RuntimeSession } from "../../src/extension/drivers/acp/runtime.ts";
import { CapabilityGateway } from "../../src/extension/bridge/capabilities.ts";
import { BridgeIPC } from "../../src/extension/bridge/ipc.ts";
import { runLiveUsage } from "./accounting.ts";
import { runLiveToolHandoff } from "./tool-handoff.ts";
import { runLivePendingUpdates } from "./pending-updates.ts";
import { ScenarioFailure } from "./report.ts";
import { liveModel } from "./settings.ts";

const cases = [
  { name: "usage", runner: "usage", returnError: false, missingUsage: false },
  { name: "handoff success", runner: "handoff", returnError: false, missingUsage: false },
  { name: "handoff error", runner: "handoff", returnError: true, missingUsage: false },
  { name: "pending update success", runner: "pending", returnError: false, missingUsage: false },
  { name: "pending update error", runner: "pending", returnError: true, missingUsage: false },
  { name: "missing billing is rejected despite context occupancy", runner: "usage", returnError: false, missingUsage: true },
] as const;

for (const row of cases) {
  test(`synthetic offline lifecycle (not model compatibility): ${row.name}`, { timeout: 25_000 }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), "agy-contract-audit-"));
    const savedEnv = { ...process.env };
    const cwd = path.join(root, "project");
    const directory = path.join(root, "sessions");
    const home = path.join(root, "home");
    const gemini = path.join(root, "gemini");
    const agent = path.join(root, "agent");
    const originals = [Session.prototype.prompt, EventProcessor.prototype.process, RuntimeSession.prototype.onRuntimeEvent,
      CapabilityGateway.prototype.call, BridgeIPC.prototype.resolveToolResults];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Bounded synthetic audit expired")), 20_000);
    const evidence: unknown[] = [{ evidence: "synthetic lifecycle only; not backend/model compatibility" }];
    const calls: { id: string; name: string; arguments: unknown }[] = [];
    t.after(async () => {
      clearTimeout(timer);
      controller.abort();
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, savedEnv);
      await rm(root, { recursive: true, force: true });
    });
    await Promise.all([cwd, directory, home, gemini, agent].map(dir => mkdir(dir)));
    const socket = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(path.join(root, "probe.sock"), resolve);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      t.skip("BLOCKED: sandbox denies Unix sockets required for genuine Pi/MCP handoff");
      return;
    } finally {
      if (socket.listening) await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
    }
    // An allowlist, rather than deleting known token names, keeps subprocesses
    // isolated from credentials, NODE_OPTIONS/preloads, proxies and host state.
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, { PATH: savedEnv.PATH ?? "/usr/bin:/bin", TMPDIR: root, HOME: home, GEMINI_HOME: gemini,
      PI_CODING_AGENT_DIR: agent, PI_AGY_LIVE_MODEL: "gemini-3.8-flash", PI_AGY_LIVE_EFFORT: "low" });
    const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Offline contract audit forbids fetch"); });
    const options = { cwd, directory, model: liveModel({}), signal: controller.signal, t, evidence,
      returnError: row.returnError, onToolCall: (call: typeof calls[number]) => { calls.push(call); },
      launch: { executable: process.execPath, args: ["--experimental-transform-types", fileURLToPath(new URL("./contract-fixture.ts", import.meta.url)),
        ...(row.missingUsage ? ["missing-usage"] : [])] } };

    const run = () => row.runner === "handoff" ? runLiveToolHandoff(options)
      : row.runner === "pending" ? runLivePendingUpdates(options) : runLiveUsage(options);
    if (row.missingUsage) {
      await assert.rejects(run(), error => error instanceof ScenarioFailure && error.category === "backend"
        && /no valid billable usage/.test(error.message));
    } else await run();

    assert.equal(fetch.mock.callCount(), 0, "No network discovery or backend request may run");
    assert.equal(calls.length, row.runner === "usage" ? 0 : 1);
    if (calls.length) {
      assert.match(calls[0]!.id, /^pi_.+/);
      assert.equal(calls[0]!.name, row.runner === "pending" ? "mcp__pi__pending_probe" : "mcp__pi__live_probe");
    }
    const records = evidence as Record<string, unknown>[];
    assert.ok(records.some(item => item.piFixtureClosed === true && item.running === 0 && item.runtimes === 1 && item.brokers === 1),
      "Real ACP process and MCP broker must be closed even on rejected usage");
    assert.deepEqual(await readdir(directory), [], "Runner must remove its session state");
    assert.deepEqual([Session.prototype.prompt, EventProcessor.prototype.process, RuntimeSession.prototype.onRuntimeEvent,
      CapabilityGateway.prototype.call, BridgeIPC.prototype.resolveToolResults], originals, "Runner-scoped t.mock wrappers must be restored");
    const runtime = records.find(item => item.runtimeUsageEvents)?.runtimeUsageEvents as { type: string; usage: { totalTokens: number } }[];
    assert.ok(runtime.some(event => event.type === "usage" && event.usage.totalTokens === 321));
    assert.equal(runtime.filter(event => event.type === "accounting").length, row.missingUsage ? 0 : 1,
      "Context updates must never create duplicate/native billable accounting");
    if (!row.missingUsage) {
      const key = row.runner === "usage" ? "usageContract" : row.runner === "handoff" ? "handoffContract" : "pendingUpdateContract";
      assert.ok(records.some(item => item[key] === "PASS"), "Real runner must complete all its persisted history/accounting assertions");
    }
  });
}
