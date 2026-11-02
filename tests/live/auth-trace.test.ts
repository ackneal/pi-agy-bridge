import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runAuthScenario } from "./auth.ts";
import { ScenarioFailure } from "./report.ts";

// Existing synthetic backend verifies the harness audit only, never live compatibility.
const fixture = fileURLToPath(new URL("../../src/extension/drivers/acp/discovery-fixture.ts", import.meta.url));
for (const row of [
  { name: "positive", id: "AUTH-probe", mode: "catalog", state: "authenticated", category: undefined },
  { name: "negative", id: "AUTH-noauth", mode: "required", state: "unauthenticated", category: undefined },
  { name: "browser interception", id: "AUTH-noauth", mode: "browser", state: "unauthenticated", category: undefined },
  { name: "fragmented browser interception", id: "AUTH-noauth", mode: "fragmented-browser", state: "unauthenticated", category: undefined },
  { name: "transport is not unauthenticated", id: "AUTH-noauth", mode: "failure", state: "unauthenticated", category: "transport" },
  { name: "Pi login chooser cancellation", id: "AUTH-login-cancel", mode: "login", state: "unauthenticated", category: undefined },
  { name: "cancellation preserves actual state after earlier login", id: "AUTH-login-cancel", mode: "advertised-auth", state: "unauthenticated", category: undefined },
] as const) {
  test(`offline auth audit: ${row.name}`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), "live-auth-audit-"));
    const cwd = path.join(directory, "project");
    const gemini = path.join(directory, "gemini");
    await Promise.all([cwd, gemini].map(name => mkdir(name)));
    const env = { PI_AGY_LIVE: "1", PI_AGY_LIVE_ISOLATED: "1", PI_AGY_LIVE_AUTH_STATE: row.state,
      PI_AGY_LIVE_LOGIN: "1", PI_AGY_LIVE_AUTH_METHOD: "synthetic-auth", GEMINI_HOME: gemini, PI_CODING_AGENT_DIR: directory };
    const saved = Object.fromEntries([...Object.keys(env), "AGY_ACP_DIR"].map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    delete process.env.AGY_ACP_DIR;
    t.after(async () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(directory, { recursive: true, force: true });
    });
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("Local audit must not fetch"));
    const evidence: unknown[] = [];
    const operation = runAuthScenario({ id: row.id, connection: { executable: process.execPath,
      args: ["--experimental-transform-types", fixture, row.mode], cwd, requestTimeoutMs: 3000 },
      directory, t, signal: AbortSignal.timeout(10_000), evidence });
    if (row.category) await assert.rejects(operation, error => error instanceof ScenarioFailure && error.category === row.category);
    else {
      try { await operation; }
      catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        if (cause instanceof assert.AssertionError) t.diagnostic(cause.message);
        else t.diagnostic(`Audit failure kind: ${cause instanceof Error ? cause.name : typeof cause}`);
        throw error;
      }
    }
    assert.equal(fetch.mock.callCount(), 0);
    const audit = evidence[evidence.length - 1] as { browserBlockers: boolean[]; remainingConnections: number;
      rpcOutcomes: { method: string; success: boolean; code?: number }[]; authenticateCount: number };
    assert.equal(audit.remainingConnections, 0);
    assert.ok(audit.browserBlockers.length > 0);
    if (row.id === "AUTH-login-cancel") assert.deepEqual(audit.browserBlockers, [true, false, true]);
    else assert.deepEqual(audit.browserBlockers, [true]);
    assert.equal(audit.authenticateCount, 0);
    assert.ok(audit.rpcOutcomes.some(rpc => rpc.method === "initialize"));
    assert.equal(JSON.stringify(evidence).includes("synthetic-secret"), false, "Never retain auth URLs or browser arguments");
  });
}
