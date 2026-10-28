import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { AcpDriver } from "./driver.ts";
import { AcpConnection } from "./connection.ts";
import type { DriverInstallationProgress } from "../types.ts";
import { acpDistributionName, resolveAcpRelease } from "./release.ts";
import { LiveSession } from "../../session/session.ts";
import { RuntimeSessionSync } from "../../session/state.ts";
import type { PrepareDriverInput } from "../types.ts";

async function isolate(t: TestContext): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "acp-resolution-"));
  const variables = ["AGY_ACP_BIN", "PI_CODING_AGENT_DIR", "GEMINI_HOME"] as const;
  const previous = variables.map((name) => process.env[name]);
  delete process.env.AGY_ACP_BIN;
  process.env.PI_CODING_AGENT_DIR = home;
  process.env.GEMINI_HOME = home;
  t.after(async () => {
    for (const [index, name] of variables.entries()) {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    }
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

function login(driver: AcpDriver): Promise<void> {
  return driver.authentication.login({
    signal: new AbortController().signal, notify: () => {},
    prompt: async () => { throw new Error("Unexpected authentication prompt"); },
  }, () => {});
}

function preparation(signal: AbortSignal, checkpoint?: Error): PrepareDriverInput {
  const session = new LiveSession("resolver-test");
  return {
    model: { id: "raw" } as Model<any>, context: { messages: [] }, tools: [], options: { signal }, session,
    preparationId: session.beginPreparation(), sync: new RuntimeSessionSync(),
    store: { get: async () => { if (checkpoint) throw checkpoint; return undefined; }, delete: async () => {} },
  };
}

for (const entry of ["login", "prepare"] as const) {
  test(`ACP ${entry} resolves installation and progress before opening a connection`, async (t) => {
    await isolate(t);
    const signal = new AbortController().signal;
    const failure = new Error("stop after resolver progress");
    const event: DriverInstallationProgress = { phase: "download", message: "Downloading fixture", version: "1.4.3", platform: "test" };
    const progress: DriverInstallationProgress[] = [];
    const loginProgress: string[] = [];
    let resolutions = 0;
    const driver = new AcpDriver(async (options) => {
      resolutions++;
      assert.equal(options?.signal, signal);
      options?.onProgress?.(event);
      throw failure;
    });
    driver.onInstallationProgress = (value) => progress.push(value);
    const start = t.mock.method(AcpConnection.prototype, "start", async () => { throw new Error("Unexpected ACP launch"); });
    assert.equal(driver.detectExecutable(), undefined);
    assert.equal(resolutions, 0);
    const attempt = entry === "login" ? driver.authentication.login({ signal, notify: (value) => { if (value.type === "progress") loginProgress.push(value.message); },
        prompt: async () => { throw new Error("Unexpected authentication prompt"); } }, () => {}) : driver.prepareSession(preparation(signal));
    await assert.rejects(attempt, (error) => error === failure);
    assert.equal(resolutions, 1);
    assert.deepEqual(progress, [event]);
    assert.deepEqual(loginProgress, entry === "login" ? [event.message] : []);
    assert.equal(start.mock.callCount(), 0);
  });
}

for (const entry of ["probe", "models"] as const) {
  test(`ACP ${entry} resolves installation before opening a connection`, async (t) => {
    await isolate(t);
    let resolutions = 0;
    const driver = new AcpDriver(async () => { resolutions++; throw new Error("Unexpected installation"); });
    const start = t.mock.method(AcpConnection.prototype, "start", async () => { throw new Error("Unexpected ACP launch"); });
    const operation = entry === "probe"
      ? driver.authentication.probe(new AbortController().signal, () => {})
      : driver.discoverModels(new AbortController().signal);
    await assert.rejects(operation, /Unexpected installation/);
    assert.equal(resolutions, 1);
    assert.equal(start.mock.callCount(), 0);
  });
}

for (const kind of ["missing", "directory", "non-executable"] as const) {
  test(`invalid ${kind} AGY_ACP_BIN never triggers a managed download`, async (t) => {
    const home = await isolate(t);
    const override = path.join(home, "override");
    if (kind === "directory") await mkdir(override);
    if (kind === "non-executable") await writeFile(override, "not executable", { mode: 0o600 });
    process.env.AGY_ACP_BIN = override;
    let resolutions = 0;
    const driver = new AcpDriver(async () => { resolutions++; throw new Error("Unexpected managed download"); });
    await assert.rejects(login(driver), /AGY_ACP_BIN is not an executable file/);
    assert.equal(resolutions, 0);
  });
}

test("explicit executable bypasses installation before opening a connection", async (t) => {
  const home = await isolate(t);
  process.env.AGY_ACP_BIN = path.join(home, "custom");
  await writeFile(process.env.AGY_ACP_BIN, "not a real ACP server", { mode: 0o700 });
  let resolutions = 0;
  const driver = new AcpDriver(async () => { resolutions++; throw new Error("Unexpected managed download"); });
  const stopped = new Error("Reached explicit ACP connection");
  const start = t.mock.method(AcpConnection.prototype, "start", async () => { throw stopped; });
  await assert.rejects(login(driver), (error) => error === stopped);
  assert.equal(resolutions, 0);
  assert.equal(start.mock.callCount(), 1);
});

for (const kind of ["aborted", "superseded"] as const) {
  test(`${kind} ACP preparation does not start installation`, async (t) => {
    await isolate(t);
    let resolutions = 0;
    const driver = new AcpDriver(async () => { resolutions++; throw new Error("Unexpected installation"); });
    const controller = new AbortController();
    const input = preparation(controller.signal, new Error("Unexpected checkpoint"));
    if (kind === "aborted") controller.abort(new Error("cancel preparation"));
    else input.session.beginPreparation();
    await assert.rejects(driver.prepareSession(input), kind === "aborted" ? /cancel preparation/ : /superseded/);
    assert.equal(resolutions, 0);
  });
}

for (const stale of [false, true]) {
  test(`managed cache passes integrity resolution with ${stale ? "a stale" : "a current"} status hint`, async (t) => {
    const home = await isolate(t);
    const release = resolveAcpRelease();
    const root = path.join(home, "pi-agy-bridge", "acp");
    const directory = path.join(root, acpDistributionName(release));
    await mkdir(directory, { recursive: true });
    const data = "synthetic executable, never launched";
    const files = [];
    for (const name of ["agy_acp_server.par", "localharness_external"]) {
      await writeFile(path.join(directory, name), data, { mode: 0o700 });
      files.push({ path: name, type: "file", mode: 0o700, size: Buffer.byteLength(data), sha256: createHash("sha256").update(data).digest("hex") });
    }
    await writeFile(path.join(directory, ".pi-agy-installation.json"), JSON.stringify({ schema: 1, version: release.version, platform: release.platform, sha256: release.sha256, files }));
    const failure = new Error("Managed integrity resolver invoked");
    let resolutions = 0;
    const driver = new AcpDriver(async () => { resolutions++; throw failure; });
    t.mock.method(driver, "detectExecutable", () => path.join(directory, release.executable));
    assert.equal(driver.detectExecutable(), path.join(directory, release.executable));
    assert.equal(resolutions, 0);
    const start = t.mock.method(AcpConnection.prototype, "start", async () => { throw new Error("Unexpected launch without integrity resolution"); });

    await assert.rejects(login(driver), (error) => error === failure);

    assert.equal(resolutions, 1);
    assert.equal(start.mock.callCount(), 0);
  });
}
