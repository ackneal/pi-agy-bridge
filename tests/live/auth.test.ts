import assert from "node:assert/strict";
import { test } from "node:test";
import { Connection as AcpConnection } from "../../src/extension/drivers/acp/connection.ts";
import { runAuthScenario } from "./auth.ts";
import { ScenarioFailure, ScenarioOutcome } from "./report.ts";

type Id = Parameters<typeof runAuthScenario>[0]["id"];
const keys = ["PI_AGY_LIVE", "PI_AGY_LIVE_ISOLATED", "PI_AGY_LIVE_AUTH_STATE", "PI_AGY_LIVE_LOGIN", "PI_AGY_LIVE_AUTH_METHOD"] as const;
type Environment = Partial<Record<typeof keys[number], string>>;
const consent: Environment = { PI_AGY_LIVE: "1", PI_AGY_LIVE_ISOLATED: "1" };
const loginConsent: Environment = { ...consent, PI_AGY_LIVE_LOGIN: "1", PI_AGY_LIVE_AUTH_METHOD: "exact-method" };
const rows: { name: string; id: Id; env: Environment; outcome: "SKIP" | "setup" | "aborted"; message?: RegExp }[] = [
  { name: "probe requires live opt-in", id: "AUTH-probe", env: {}, outcome: "SKIP", message: /PI_AGY_LIVE=1/ },
  { name: "probe requires isolation", id: "AUTH-probe", env: { PI_AGY_LIVE: "1" }, outcome: "SKIP", message: /PI_AGY_LIVE_ISOLATED=1/ },
  { name: "negative defaults to skip, not credential mutation", id: "AUTH-noauth", env: consent, outcome: "SKIP", message: /externally configured/ },
  { name: "negative rejects authenticated environment", id: "AUTH-noauth", env: { ...consent, PI_AGY_LIVE_AUTH_STATE: "authenticated" }, outcome: "SKIP", message: /unauthenticated/ },
  { name: "positive skips explicitly unauthenticated environment", id: "AUTH-probe", env: { ...consent, PI_AGY_LIVE_AUTH_STATE: "unauthenticated" }, outcome: "SKIP", message: /authenticated/ },
  { name: "unknown state is a setup failure", id: "AUTH-noauth", env: { ...consent, PI_AGY_LIVE_AUTH_STATE: "unknown" }, outcome: "setup" },
  { name: "empty state is not default authentication", id: "AUTH-probe", env: { ...consent, PI_AGY_LIVE_AUTH_STATE: "" }, outcome: "setup" },
  { name: "default positive passes gates only", id: "AUTH-probe", env: consent, outcome: "aborted" },
  { name: "explicit negative passes gates only", id: "AUTH-noauth", env: { ...consent, PI_AGY_LIVE_AUTH_STATE: "unauthenticated" }, outcome: "aborted" },
];
for (const id of ["AUTH-login", "AUTH-login-cancel"] as const) {
  rows.push(
    { name: `${id} requires extra consent`, id, env: consent, outcome: "SKIP", message: /PI_AGY_LIVE_LOGIN=1/ },
    { name: `${id} rejects truthy non-consent`, id, env: { ...consent, PI_AGY_LIVE_LOGIN: "true" }, outcome: "SKIP", message: /PI_AGY_LIVE_LOGIN=1/ },
    { name: `${id} requires explicit method`, id, env: { ...consent, PI_AGY_LIVE_LOGIN: "1" }, outcome: "SKIP", message: /PI_AGY_LIVE_AUTH_METHOD/ },
    { name: `${id} rejects blank method`, id, env: { ...loginConsent, PI_AGY_LIVE_AUTH_METHOD: "  " }, outcome: "SKIP", message: /PI_AGY_LIVE_AUTH_METHOD/ },
    { name: `${id} still requires isolation`, id, env: { ...loginConsent, PI_AGY_LIVE_ISOLATED: "0" }, outcome: "SKIP", message: /PI_AGY_LIVE_ISOLATED/ },
    { name: `${id} explicit consent passes gates only`, id, env: loginConsent, outcome: "aborted" },
    { name: `${id} permits dedicated unauthenticated login`, id, env: { ...loginConsent, PI_AGY_LIVE_AUTH_STATE: "unauthenticated" }, outcome: "aborted" },
  );
}

for (const row of rows) {
  test(`offline auth consent: ${row.name}`, async t => {
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const home = process.env.HOME;
    const gemini = process.env.GEMINI_HOME;
    t.after(() => {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
    for (const key of keys) {
      if (row.env[key] === undefined) delete process.env[key];
      else process.env[key] = row.env[key];
    }
    const start = t.mock.method(AcpConnection.prototype, "start", () => assert.fail("Consent tests must never execute ACP"));
    const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("Consent tests must never access the network"));
    const aborted = new Error("Offline gate boundary");
    const evidence: unknown[] = [];

    await assert.rejects(runAuthScenario({
      id: row.id, connection: { executable: "/must-not-execute", cwd: "/must-not-read" },
      directory: "/must-not-write", signal: AbortSignal.abort(aborted), t, evidence,
    }), error => {
      if (row.outcome === "aborted") return error === aborted;
      if (row.outcome === "setup") return error instanceof ScenarioFailure && error.category === "setup";
      return error instanceof ScenarioOutcome && error.status === "SKIP" && row.message!.test(error.message);
    });
    assert.equal(start.mock.callCount(), 0);
    assert.equal(fetch.mock.callCount(), 0);
    assert.deepEqual(evidence, []);
    assert.equal(process.env.HOME, home);
    assert.equal(process.env.GEMINI_HOME, gemini);
  });
}
