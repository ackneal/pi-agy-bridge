import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Connection } from "../../src/extension/drivers/acp/connection.ts";
import { executionMode, localScenarioRestriction, prepareLiveEnvironment } from "./environment.ts";
import { ScenarioOutcome } from "./report.ts";

const local = { PI_AGY_LIVE: "1", PI_AGY_LIVE_MODE: "local", PI_AGY_LIVE_LOCAL: "1", PI_AGY_LIVE_SCENARIOS: "AUTH-probe,CONFIG-instructions" };
for (const row of [
  { name: "opt-out local", platform: "darwin", env: { ...local, PI_AGY_LIVE: "" }, error: /PI_AGY_LIVE=1/ },
  { name: "Linux isolation", platform: "linux", env: { PI_AGY_LIVE: "1", PI_AGY_LIVE_ISOLATED: "1" }, expected: "isolated" },
  { name: "macOS cannot attest Linux isolation", platform: "darwin", env: { PI_AGY_LIVE: "1", PI_AGY_LIVE_ISOLATED: "1" }, error: /disposable Linux/ },
  { name: "local consent", platform: "darwin", env: local, expected: "local" },
  { name: "Linux cannot use local", platform: "linux", env: local, error: /macOS/ },
  { name: "missing local consent", platform: "darwin", env: { ...local, PI_AGY_LIVE_LOCAL: "" }, error: /PI_AGY_LIVE_LOCAL=1/ },
  { name: "local is not isolated", platform: "darwin", env: { ...local, PI_AGY_LIVE_ISOLATED: "1" }, error: /cannot attest isolation/ },
  { name: "explicit selection", platform: "darwin", env: { ...local, PI_AGY_LIVE_SCENARIOS: " " }, error: /selection/ },
  { name: "no negative authentication", platform: "darwin", env: { ...local, PI_AGY_LIVE_AUTH_STATE: "unauthenticated" }, error: /negative authentication/ },
  { name: "no login consent", platform: "darwin", env: { ...local, PI_AGY_LIVE_LOGIN: "1" }, error: /login is disabled/ },
  { name: "reject directory override", platform: "darwin", env: { ...local, AGY_ACP_DIR: "/host/tool" }, error: /overrides/ },
  { name: "reject legacy override", platform: "darwin", env: { ...local, AGY_ACP_BIN: "/host/tool" }, error: /overrides/ },
  { name: "invalid mode", platform: "linux", env: { PI_AGY_LIVE: "1", PI_AGY_LIVE_MODE: "bogus" }, error: /MODE/ },
]) {
  test(`execution gate: ${row.name}`, () => {
    if (row.error) assert.throws(() => executionMode(row.env, row.platform), row.error);
    else assert.equal(executionMode(row.env, row.platform), row.expected);
  });
}

for (const row of [
  { id: "AUTH-probe", restricted: false }, { id: "A-success", restricted: false },
  { id: "A-update-error", restricted: false }, { id: "G-compaction", restricted: false },
  { id: "AUTH-noauth", restricted: true }, { id: "AUTH-login", restricted: true },
  { id: "AUTH-login-cancel", restricted: true }, { id: "B-native", restricted: true },
  { id: "READ-scope", restricted: true },
]) {
  test(`local scenario policy: ${row.id}`, () => {
    assert.equal(localScenarioRestriction(row.id) !== undefined, row.restricted);
  });
}

for (const install of [false, true]) {
 test(`setup gate/failed download preserves backend state: install=${install}`, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "live-environment-test-")));
  const home = path.join(root, "home");
  const gemini = path.join(root, "gemini");
  await Promise.all([home, gemini].map(directory => mkdir(directory)));
  await writeFile(path.join(gemini, "sentinel"), "unchanged");
  const changes = { ...local, PI_AGY_LIVE_MODE: process.platform === "darwin" ? "local" : "isolated", PI_AGY_LIVE_ISOLATED: process.platform === "linux" ? "1" : "",
    PI_AGY_LIVE_WORKSPACE: root, PI_AGY_LIVE_INSTALL: install ? "1" : "", PI_AGY_LIVE_LOGIN: "", PI_AGY_LIVE_AUTH_STATE: "authenticated",
    HOME: home, GEMINI_HOME: gemini, AGY_ACP_DIR: "", AGY_ACP_BIN: "" };
  const saved = { ...process.env };
  Object.assign(process.env, changes);
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(root, { recursive: true, force: true });
  });
  const start = t.mock.method(Connection.prototype, "start", async () => assert.fail("Gate must not start ACP"));
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    assert.ok(install, "Gate must not download without consent");
    throw new Error("Deliberate offline download failure");
  });
  const before = { ...process.env };
  await assert.rejects(prepareLiveEnvironment({ reportDirectory: path.join(tmpdir(), "outside-report"), timeoutMs: 1000,
    signal: AbortSignal.timeout(1000), environment: {} }), error => install
      ? error instanceof Error && error.message.includes("Deliberate offline download failure")
      : error instanceof ScenarioOutcome && error.status === "SKIP" && /INSTALL/.test(error.message));
  if (install) {
    const scratch = path.dirname(process.env.PI_CODING_AGENT_DIR!);
    await assert.rejects(lstat(scratch), (error: NodeJS.ErrnoException) => error.code === "ENOENT", "Failed setup must remove only its scratch storage");
  } else {
    assert.ok([...new Set([...Object.keys(process.env), ...Object.keys(before)])].every(key => process.env[key] === before[key]),
      "Setup gate must not change inherited environment values");
  }
  assert.equal(process.env.HOME, home);
  assert.equal(process.env.GEMINI_HOME, gemini);
  assert.deepEqual((await readdir(root)).sort(), ["gemini", "home"]);
  assert.equal(await readFile(path.join(gemini, "sentinel"), "utf8"), "unchanged");
  assert.equal(start.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), install ? 1 : 0);
 });
}
