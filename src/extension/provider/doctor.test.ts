import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import fs, { writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";

let execute: ((args: readonly string[], signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>) | undefined;
const originalExecFile = cp.execFile;
const originalPromisified = promisify(originalExecFile);
const replacement = Object.assign((...args: any[]) => (originalExecFile as any)(...args), {
  [promisify.custom]: (_file: string, args: readonly string[], options: { signal?: AbortSignal }) => {
    if (execute) return execute(args, options?.signal);
    return originalPromisified(_file, args as any, options as any);
  },
});
cp.execFile = replacement as unknown as typeof cp.execFile;
syncBuiltinESMExports();

import type { Provider } from "@earendil-works/pi-ai";
import { ModelRuntime, readStoredCredential, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgyUsage } from "../runtime/usage.ts";
import { AuthenticationRequiredError } from "../shared/types.ts";
import { AgyAuthentication, createAgyBridgeCredential } from "./auth.ts";
import { registerAuthHomeFixture, useAuthHomeFixture } from "./auth-home-fixture.ts";

const { DEFAULT_AGY_PLUGIN_DIR } = await import("../discovery/plugin-install.ts");
const { Driver: AcpDriver } = await import("../drivers/acp/driver.ts");
const { Driver: CliDriver } = await import("../drivers/cli/driver.ts");
const { fetchAgyUsage } = await import("../runtime/usage.ts");
const { collectDoctorReport } = await import("./doctor.ts");
const { Bridge } = await import("./provider.ts");

useAuthHomeFixture();

test("doctor reads isolated fixtures without installing or discovering", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agy-doctor-"));
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const source = path.join(home, "source");
    const target = path.join(home, ".gemini/config/plugins/example");
    const executable = path.join(home, "agy");
    const calls = path.join(home, "calls");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "plugin.json"), JSON.stringify({ name: "example", version: "2.0.0" }));
    await fs.writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n[ "$*" = '--version' ] || exit 99\necho 'agy 1.2.0'\n`);
    await fs.chmod(executable, 0o755);
    const options = { driver: "cli" as const, executable, pluginDir: source };
    for (const row of [
      { manifest: undefined, expected: /! Plugin example not installed/, followup: /Will install automatically on next Antigravity CLI use\./ },
      { manifest: '{"name":"example","version":"2.0.0"}', expected: /  ✓ Antigravity CLI 1.2.0 \(Plugin 2.0.0\)\n/, followup: /✓ Pi MCP bridge entrypoint found/ },
      { manifest: '{"name":"example","version":"1.0.0"}', expected: /Plugin example 1.0.0 -> bundled 2.0.0/, followup: /Will update automatically on next Antigravity CLI use\./ },
      { manifest: '{broken', expected: /✗ Plugin error/, followup: /Models: 0 cached/ },
      { manifest: '{}', expected: /✗ Plugin error/, followup: /Models: 0 cached/ },
    ]) {
      await fs.rm(target, { recursive: true, force: true });
      if (row.manifest !== undefined) {
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, "plugin.json"), row.manifest);
      }
      const report = await collectDoctorReport(options);
      assert.match(report, row.expected);
      assert.match(report, row.followup);
      assert.match(report, /^agy-bridge doctor\n/);
      assert.match(report, /  ✓ Antigravity CLI 1.2.0(?: \(Plugin 2.0.0\))?\n/);
      assert.doesNotMatch(report, /  ✓ Plugin /);
      assert.doesNotMatch(report, /\(minimum /);
      assert.match(report, /✓ Pi MCP bridge entrypoint/);
      if (row.manifest === undefined) await assert.rejects(fs.access(target));
      else assert.equal(await fs.readFile(path.join(target, "plugin.json"), "utf8"), row.manifest);
    }
    const { DEFAULT_AGY_PLUGIN_DIR } = await import("../discovery/plugin-install.ts");
    const bundled = JSON.parse(await fs.readFile(path.join(DEFAULT_AGY_PLUGIN_DIR, "plugin.json"), "utf8"));
    const defaultReport = await collectDoctorReport({ driver: "cli", executable });
    assert.ok(defaultReport.includes(`  ! Plugin ${bundled.name} not installed (bundled ${bundled.version})`));
    assert.match(defaultReport, /Will install automatically on next Antigravity CLI use\./);
    await assert.rejects(fs.access(path.join(home, ".gemini/config/plugins", bundled.name)));

    for (const row of [
      { catalogModels: undefined, models: undefined, expected: /! Models: 0 cached/ },
      { catalogModels: [], models: undefined, expected: /! Models: 0 cached/ },
      { catalogModels: [{ id: "a", name: "A" }], models: undefined, expected: /✓ Models: 1 cached/ },
      { catalogModels: [1], models: [], expected: /! Models: 0 configured/ },
      { catalogModels: [], models: [1, 2], expected: /✓ Models: 2 configured/ },
    ]) {
      const report = await collectDoctorReport({ ...options, catalogModels: row.catalogModels, models: row.models });
      assert.match(report, row.expected);
      if (row.models !== undefined) assert.doesNotMatch(report, /cached/);
    }
    for (const row of [
      {
        name: "unknown without local credential information remains unknown",
        authStatus: "unknown",
        expected: /x Auth: unknown/,
        authError: undefined,
        errors: false,
      },
      {
        name: "unknown with an auth error remains unknown",
        authStatus: "unknown",
        expected: /x Auth: unknown/,
        authError: { time: "2026-01-03T00:00:00Z", message: "login check failed" },
        errors: true,
      },
      { name: "authenticated", authStatus: "authenticated", expected: /✓ Auth: authenticated/, authError: undefined, errors: false },
      { name: "unauthenticated", authStatus: "unauthenticated", expected: /x Auth: unauthenticated/, authError: undefined, errors: false },
      { name: "saved credential is not backend verification", authStatus: "saved", expected: /x Auth: saved login \(backend unverified\)/, authError: undefined, errors: false },
    ] as const) {
      const report = await collectDoctorReport({ ...options, authStatus: row.authStatus, authError: row.authError });
      assert.match(report, row.expected, row.name);
      if (row.errors) {
        assert.match(report, /Errors\n  ! authentication \(2026-01-03T00:00:00Z\): login check failed/, row.name);
      } else {
        assert.doesNotMatch(report, /Errors/, row.name);
      }
    }
    await fs.writeFile(path.join(source, "plugin.json"), '{}');
    const report = await collectDoctorReport({
      ...options, executable: path.join(home, "missing"), models: [1, 2],
      pluginError: { time: "2026-01-01T00:00:00Z", message: "install failed" },
      discoveryError: { time: "2026-01-02T00:00:00Z", message: "discovery failed" },
      authStatus: "unauthenticated",
      authError: { time: "2026-01-03T00:00:00Z", message: "login failed" },
      usage: {
        updatedAt: "2026-10-17T04:19:59Z",
        groups: [{ name: "Gemini 4 Argon", buckets: [{ id: "argon", name: "Weekly", window: "weekly", remainingFraction: 0.4 }] }],
      },
      usageError: { time: "2026-01-04T00:00:00Z", message: "usage failed" },
    });
    for (const pattern of [
      /✗ Antigravity CLI error/,
      /✗ Plugin error/,
      /✓ Models: 2 configured/,
      /✓ Node /,
      /✓ Pi MCP bridge entrypoint/,
      /x Auth: unauthenticated/,
      /Quota remaining\n  Gemini 4 Argon  weekly 40%/,
      /Errors/,
      /! plugin \(2026-01-01T00:00:00Z\): install failed/,
      /! discovery \(2026-01-02T00:00:00Z\): discovery failed/,
      /! authentication \(2026-01-03T00:00:00Z\): login failed/,
      /! usage \(2026-01-04T00:00:00Z\): usage failed/,
    ]) assert.match(report, pattern);
    assert.ok((await fs.readFile(calls, "utf8")).trim().split("\n").every(call => call === "--version"));
    for (const row of [
      { name: "Build label", output: "Python 3.13.2\nBuild label: 1.4.1\n", runtime: "  ✓ Antigravity ACP 1.4.1" },
      { name: "missing version", output: "Python 3.13.2\n", runtime: "  ✓ Antigravity ACP" },
      { name: "empty version", output: "Build label:\n", runtime: "  ✓ Antigravity ACP" },
    ]) {
      const expectedArgs = process.platform === "linux" ? "--uid= --version" : "--version";
      await fs.writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n[ "$*" = '${expectedArgs}' ] || exit 99\nprintf '%s' '${row.output}'\n`);
      await fs.writeFile(calls, "");

      const acpReport = await collectDoctorReport({
        driver: "acp",
        executable,
        models: [1, 2],
        authStatus: "unauthenticated",
        discoveryError: { time: "2026-01-02T00:00:00Z", message: "discovery failed" },
        authError: { time: "2026-01-03T00:00:00Z", message: "login failed" },
        usage: {
          updatedAt: "2026-10-17T04:19:59Z",
          groups: [{ name: "Gemini 4 Argon", buckets: [{ id: "argon", name: "Weekly", window: "weekly", remainingFraction: 0.4 }] }],
        },
      });

      assert.match(acpReport, /^agy-bridge doctor\n\nRuntime\n/, row.name);
      assert.ok(acpReport.split("\n").includes(row.runtime), row.name);
      assert.match(acpReport, /  ✓ Node /, row.name);
      assert.match(acpReport, /  ✓ Pi MCP bridge entrypoint found\n/, row.name);
      assert.match(acpReport, /  ✓ Models: 2 configured\n  x Auth: unauthenticated/, row.name);
      assert.match(acpReport, /\n\nQuota remaining \(unavailable\)\n\nErrors\n  ! discovery \(2026-01-02T00:00:00Z\): discovery failed\n  ! authentication \(2026-01-03T00:00:00Z\): login failed$/, row.name);
      assert.doesNotMatch(acpReport, /Antigravity CLI|Plugin|Gemini 4 Argon|Python/, row.name);
      assert.equal(await fs.readFile(calls, "utf8"), `${expectedArgs}\n`, row.name);
      assert.equal(await fs.readFile(path.join(source, "plugin.json"), "utf8"), "{}");
      assert.equal(await fs.readFile(path.join(target, "plugin.json"), "utf8"), "{}");
    }

  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  }
});

for (const driverId of ["cli", "acp"] as const) {
  for (const outcome of ["authenticated", "unauthenticated", "unknown"] as const) {
    test(`${driverId} doctor synchronizes ${outcome} without a second notification`, async (t) => {
      const directory = await registerAuthHomeFixture(t);
      const authPath = path.join(directory, "auth.json");
      const original = { ...createAgyBridgeCredential(), driver: driverId };
      await writeFile(authPath, JSON.stringify({ agy: original }));
      const driver = driverId === "cli" ? new CliDriver() : new AcpDriver();
      t.mock.method(driver, "detectExecutable", () => undefined);
      const login = t.mock.method(driver.authentication, "login", async () => { throw new Error("must not log in"); });
      t.mock.method(driver.authentication, "probe", async () => {
        if (outcome === "unknown") throw new Error("fixture transport error");
        return outcome === "authenticated";
      });
      t.mock.method(driver, "usage", async () => {
        if (driverId === "acp") return undefined;
        if (outcome === "unauthenticated") throw new AuthenticationRequiredError();
        if (outcome === "unknown") throw new Error("fixture transport error");
        return { updatedAt: "2026-01-01T00:00:00Z", groups: [] };
      });
      let doctor!: (args: string, context: ExtensionContext) => Promise<void>;
      let shutdown!: () => Promise<void>;
      const sendMessage = t.mock.fn();
      const notify = t.mock.fn();
      const refresh = t.mock.fn(async () => {});
      const bridge = new Bridge({
        registerCommand: (name: string, command: { handler: typeof doctor }) => { if (name === "agy-bridge:doctor") doctor = command.handler; },
        registerProvider: () => {}, sendMessage,
        on: (name: string, handler: typeof shutdown) => { if (name === "session_shutdown") shutdown = handler; },
      } as unknown as ExtensionAPI, driver);
      bridge.start();
      t.after(() => shutdown());

      const piLogin = t.mock.method(ModelRuntime.prototype, "login");
      const piLogout = t.mock.method(ModelRuntime.prototype, "logout");
      const context = { hasUI: true, ui: { notify, setStatus: () => {} }, modelRegistry: { refresh } } as unknown as ExtensionContext;
      await doctor("", context);
      await doctor("", context);

      assert.equal(piLogin.mock.callCount(), 0);
      assert.equal(piLogout.mock.callCount(), outcome === "unauthenticated" ? 1 : 0);
      assert.equal(login.mock.callCount(), 0);
      assert.equal(notify.mock.callCount(), 0);
      assert.equal(sendMessage.mock.callCount(), 2);
      assert.match(sendMessage.mock.calls[0]!.arguments[0].content, new RegExp(`Auth: ${outcome}`));
      if (outcome === "unauthenticated") assert.match(sendMessage.mock.calls[0]!.arguments[0].content, /Run \/login and select Antigravity \[pi-agy-bridge\]/);
      assert.deepEqual(refresh.mock.calls[0]!.arguments, [{ providers: ["agy"], allowNetwork: false }]);
      const record = readStoredCredential("agy", authPath);
      if (outcome === "unauthenticated") assert.equal(record, undefined);
      else if (outcome === "unknown") assert.deepEqual(record, original);
      else {
        assert.equal(record?.type, "oauth");
        if (record?.type === "oauth") {
          assert.equal(record.driver, driverId);
          assert.equal(record.loginEpoch, undefined);
        }
      }
    });
  }
}

test("doctor command progress and reporting", async (t) => {
  for (const row of [
    { name: "success", hasUI: true, failure: false, shutdown: false, switch: false },
    { name: "diagnostic detection failure", hasUI: true, failure: true, shutdown: false, switch: false },
    { name: "shutdown while usage is pending", hasUI: true, failure: false, shutdown: true, switch: false },
    { name: "headless", hasUI: false, failure: false, shutdown: false, switch: false },
    { name: "post-switch diagnostics failure is not a switch failure", hasUI: true, failure: true, shutdown: false, switch: true },
  ]) {
    await t.test(row.name, async (t) => {
      type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      const commands = new Map<string, Handler>();
      let shutdown!: () => Promise<void>;
      const sendMessage = t.mock.fn();
      const setStatus = t.mock.fn();
      const bridge = new Bridge({
        registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command.handler),
        registerProvider: () => {},
        on: (name: string, handler: () => Promise<void>) => { if (name === "session_shutdown") shutdown = handler; },
        sendMessage,
      } as unknown as ExtensionAPI, row.switch ? new CliDriver() : new AcpDriver());
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      let pending: Promise<void> | undefined;
      t.after(async () => {
        release();
        await pending;
        await shutdown();
      });
      t.mock.method(AgyAuthentication.prototype, "detect", async () => undefined);
      const usage = t.mock.method(row.switch ? AcpDriver.prototype : bridge.driver, "usage", async (signal: AbortSignal) => {
        assert.equal(signal.aborted, false);
        entered();
        await gate;
        return undefined;
      });
      const detect = t.mock.method(row.switch ? AcpDriver.prototype : bridge.driver, "detectExecutable", () => {
        if (row.failure) throw new Error("synthetic diagnostics failure");
        return undefined;
      });
      if (row.switch) t.mock.method(AcpDriver.prototype, "discoverModels", async () => []);
      bridge.start();
      const ctx = { hasUI: row.hasUI, ui: { setStatus } } as unknown as ExtensionCommandContext;

      pending = commands.get(row.switch ? "agy-bridge:driver" : "agy-bridge:doctor")!(row.switch ? "acp" : "", ctx);
      await reached;

      const checking = ["agy-bridge", "Checking Antigravity ACP diagnostics…"];
      assert.deepEqual(setStatus.mock.calls.map((call) => call.arguments), row.hasUI
        ? row.switch ? [["agy-bridge", "Switching to Antigravity ACP…"], ["agy-bridge", undefined], checking] : [checking]
        : []);
      assert.equal(usage.mock.callCount(), 1);
      assert.equal(detect.mock.callCount(), 0);
      assert.equal(sendMessage.mock.callCount(), 0);
      if (row.shutdown) await shutdown();
      release();
      await pending;

      assert.deepEqual(setStatus.mock.calls.at(-1)?.arguments, row.hasUI ? ["agy-bridge", undefined] : undefined);
      assert.equal(setStatus.mock.callCount(), row.hasUI ? row.switch ? 4 : 2 : 0);
      assert.equal(detect.mock.callCount(), row.shutdown ? 0 : 1);
      if (row.switch) assert.equal(bridge.driver.id, "acp");
      assert.equal(sendMessage.mock.callCount(), row.shutdown ? 0 : 1);
      if (!row.shutdown) {
        const [message, options] = sendMessage.mock.calls.at(-1)!.arguments as unknown as [{ customType: string; content: string; display: boolean }, unknown];
        assert.equal(message.customType, "pi-agy-bridge:doctor");
        assert.equal(message.display, true);
        assert.deepEqual(options, { triggerTurn: false });
        if (row.failure) assert.equal(message.content, "Failed to collect diagnostics: synthetic diagnostics failure");
        else assert.match(message.content, /^agy-bridge doctor\n/);
      }
    });
  }
});

const quota: AgyUsage = {
  updatedAt: "2026-01-01T00:00:00Z",
  groups: [{ name: "Fixture", buckets: [{ id: "fixture", name: "Weekly", window: "weekly", remainingFraction: 0.5 }] }],
};

for (const row of [
  { outcome: "success", status: "authenticated", hasQuota: true },
  { outcome: "required", status: "unauthenticated", hasQuota: false },
  { outcome: "network failure", status: "unknown", hasQuota: false },
] as const) {
  test(`CLI doctor refreshes previously authenticated status after ${row.outcome}`, async (t) => {
    let doctor!: () => Promise<void>;
    let shutdown!: () => Promise<void>;
    let provider!: Provider;
    const sendMessage = t.mock.fn();
    const driver = new CliDriver();
    t.mock.method(driver, "detectExecutable", () => undefined);
    const login = t.mock.method(driver.authentication, "login", async () => {});
    const usage = t.mock.method(driver, "usage", async () => {
      if (row.outcome === "required") throw new AuthenticationRequiredError();
      if (row.outcome === "network failure") throw new Error("synthetic network failure");
      return quota;
    });
    const bridge = new Bridge({
      registerCommand: (name: string, command: { handler: () => Promise<void> }) => {
        if (name === "agy-bridge:doctor") doctor = command.handler;
      },
      registerProvider: (registered: Provider) => { provider = registered; },
      on: (name: string, handler: () => Promise<void>) => { if (name === "session_shutdown") shutdown = handler; },
      sendMessage,
    } as unknown as ExtensionAPI, driver);
    bridge.start();
    t.after(() => shutdown());
    await provider.auth!.oauth!.login({
      signal: new AbortController().signal,
      notify: () => {},
      prompt: async () => { throw new Error("Fixture login must not prompt"); },
    });

    await doctor();

    assert.equal(login.mock.callCount(), 1, "doctor must not start a new login");
    assert.equal(usage.mock.callCount(), 1);
    assert.equal(sendMessage.mock.callCount(), 1);
    const [message] = sendMessage.mock.calls[0]!.arguments;
    assert.equal(message.customType, "pi-agy-bridge:doctor");
    assert.ok(message.content.includes(`Auth: ${row.status}`));
    assert.equal(message.content.includes("Quota remaining"), row.hasQuota);
    if (row.outcome === "network failure") assert.match(message.content, /! usage /);
    else assert.doesNotMatch(message.content, /! usage /);
    if (row.outcome === "network failure") assert.match(message.content, /synthetic network failure/);
  });
}

for (const row of [
  { name: "authenticated probe", result: true, expected: /Auth: authenticated/ },
  { name: "unauthenticated probe", result: false, expected: /Auth: unauthenticated/ },
  { name: "failed probe", result: new Error("network timeout"), expected: /Auth: unknown/ },
] as const) {
  test(`ACP doctor reports ${row.name} without logging in`, async (t) => {
    let doctor!: () => Promise<void>;
    const messages: string[] = [];
    const driver = new AcpDriver();
    const login = t.mock.method(driver.authentication, "login", async () => {
      throw new Error("login must not run");
    });
    const probe = t.mock.method(driver.authentication, "probe", async () => {
      if (row.result instanceof Error) throw row.result;
      return row.result;
    });
    const pi = {
      registerCommand: (name: string, command: { handler: () => Promise<void> }) => {
        if (name === "agy-bridge:doctor") doctor = command.handler;
      },
      registerProvider: () => {}, on: () => {},
      sendMessage: (message: { content: string }) => {
        messages.push(message.content);
      },
    } as unknown as ExtensionAPI;
    t.mock.method(driver, "detectExecutable", () => undefined);
    const bridge = new Bridge(pi, driver);
    bridge.start();
    assert.ok(doctor);
    await doctor();
    const report = messages.join("\n");
    assert.match(report, row.expected);
    if (row.result instanceof Error) assert.match(report, /authentication error|network timeout/i);
    assert.equal(probe.mock.callCount(), 1);
    assert.equal(login.mock.callCount(), 0);
  });
}

test("doctor suppresses reports after shutdown at each await boundary", async (t) => {
  for (const stage of ["quota", "report"] as const) {
    await t.test(stage, async (t) => {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      t.after(() => {
        execute = undefined;
        release();
      });
      const calls: string[][] = [];
      const child = Object.assign(new EventEmitter(), {
        pid: 123456,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: (signal: NodeJS.Signals) => { terminate(signal); return true; },
      });
      let closed = false;
      let terminated = false;
      const close = (code: number | null, signal: NodeJS.Signals | null) => {
        if (closed) return;
        closed = true;
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", code, signal);
        child.emit("close", code, signal);
      };
      const terminate = (signal: NodeJS.Signals) => {
        if (closed) return;
        terminated = true;
        queueMicrotask(() => close(null, signal));
      };
      t.mock.method(process, "kill", (pid: number, signal: NodeJS.Signals) => {
        assert.equal(pid, -child.pid);
        terminate(signal);
        return true;
      });
      t.mock.method(cp, "spawn", (file: string, args: readonly string[], options: cp.SpawnOptions) => {
        assert.equal(file, "/fake/agy");
        assert.deepEqual(options, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
        calls.push([...args]);
        queueMicrotask(() => {
          if (stage === "quota") entered();
          else {
            child.stdout.write("Claude  Five hour  50%");
            close(0, null);
          }
        });
        return child;
      });
      execute = async (args) => {
        calls.push([...args]);
        assert.deepEqual(args, ["--version"]);
        if (stage === "report") {
          entered();
          await gate;
        }
        return { stdout: "agy 1.0.0", stderr: "" };
      };
      let doctor: (() => Promise<void>) | undefined;
      let shutdown: (() => Promise<void>) | undefined;
      const sendMessage = t.mock.fn();
      const pi = {
        registerCommand: (name: string, command: { handler: () => Promise<void> }) => { if (name === "agy-bridge:doctor") doctor = command.handler; },
        on: (name: string, handler: () => Promise<void>) => { if (name === "session_shutdown") shutdown = handler; },
        registerProvider: () => {},
        sendMessage,
      } as unknown as ExtensionAPI;
      const bridge = new Bridge(pi, new CliDriver());
      t.mock.method(CliDriver.prototype, "usage", (signal: AbortSignal) => fetchAgyUsage("/fake/agy", signal));
      t.mock.method(CliDriver.prototype, "detectExecutable", () => "/fake/agy");
      bridge.start();
      assert.ok(doctor);
      assert.ok(shutdown);

      const pending = doctor();
      t.after(async () => {
        release();
        await shutdown!();
        await pending;
      });
      await reached;
      assert.equal(sendMessage.mock.callCount(), 0);
      assert.equal(terminated, false);
      await shutdown();
      assert.equal(terminated, stage === "quota");
      assert.equal(closed, true);
      release();
      await pending;

      assert.deepEqual(calls, stage === "quota"
        ? [["--output-format", "json", "--print", "/usage"]]
        : [["--output-format", "json", "--print", "/usage"], ["--version"]]);
      assert.equal(sendMessage.mock.callCount(), 0);
    });
  }
});

test("doctor starts a fresh query after login while the cancelled query is still closing", async (t) => {
  const controller = new AbortController();
  const pending: Promise<unknown>[] = [];
  const children: Array<ReturnType<typeof createChild>> = [];
  function createChild(pid: number) {
    return Object.assign(new EventEmitter(), {
      pid,
      stdout: new PassThrough(), stderr: new PassThrough(), closed: false,
    });
  }
  const close = (child: typeof children[number], quotaValue?: string) => {
    if (child.closed) return;
    if (quotaValue) child.stdout.write(`Claude  Five hour  ${quotaValue}%`);
    child.closed = true;
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", quotaValue ? 0 : null, quotaValue ? null : "SIGKILL");
    child.emit("close", quotaValue ? 0 : null, quotaValue ? null : "SIGKILL");
  };
  t.after(async () => {
    controller.abort();
    for (const child of children) close(child);
    await Promise.allSettled(pending);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  let loginQueryStarted!: () => void;
  const loginQuery = new Promise<void>((resolve) => { loginQueryStarted = resolve; });
  t.mock.method(cp, "spawn", () => {
    const child = createChild(123456 + children.length);
    children.push(child);
    if (children.length === 2) loginQueryStarted();
    return child;
  });
  const killed: number[] = [];
  t.mock.method(process, "kill", (pid: number) => {
    killed.push(pid);
    return true;
  });
  t.after(() => {
    execute = undefined;
  });
  execute = async () => ({ stdout: "agy 1.0.0", stderr: "" });
  let doctor!: () => Promise<void>;
  let provider!: Provider;
  const sendMessage = t.mock.fn();
  const bridge = new Bridge({
    registerCommand: (name: string, command: { handler: () => Promise<void> }) => { if (name === "agy-bridge:doctor") doctor = command.handler; },
    registerProvider: (registered: Provider) => { provider = registered; },
    on: () => {}, sendMessage,
  } as unknown as ExtensionAPI, new CliDriver());
  t.mock.method(CliDriver.prototype, "usage", (signal: AbortSignal) => fetchAgyUsage("/fake/agy", signal));
  t.mock.method(CliDriver.prototype, "detectExecutable", () => "/fake/agy");
  bridge.start();

  const oldDoctor = doctor();
  pending.push(oldDoctor);
  const login = Promise.resolve(provider.auth.oauth!.login({
    signal: controller.signal,
    notify: () => {},
    prompt: async () => { assert.fail("cached login must not prompt"); },
  }));
  pending.push(login);
  await loginQuery;
  assert.ok(killed.includes(-children[0]!.pid), "login must cancel the old query");
  assert.equal(children[0]!.closed, false, "cancelled query has not finished closing");
  close(children[1]!, "10");
  await login;

  const freshDoctor = doctor();
  pending.push(freshDoctor);
  assert.equal(children.length, 3, "new doctor must launch its own query");
  close(children[0]!);
  await oldDoctor;
  assert.equal(sendMessage.mock.callCount(), 0, "cancelled doctor must not publish");
  const joinedDoctor = doctor();
  pending.push(joinedDoctor);
  assert.equal(children.length, 3, "old cleanup must not discard the new shared query");
  close(children[2]!, "75");
  await Promise.all([freshDoctor, joinedDoctor]);

  assert.equal(sendMessage.mock.callCount(), 2);
  for (const call of sendMessage.mock.calls) {
    assert.match((call.arguments[0] as { content: string }).content, /5h 75%/);
  }
});

test("doctor reports installation errors without starting a model turn", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agy-doctor-command-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let handler: (() => Promise<void>) | undefined;
  const sendMessage = t.mock.fn();
  const pi = {
    on: () => {},
    registerProvider: () => {},
    registerCommand: (name: string, command: { handler: () => Promise<void> }) => {
      if (name === "agy-bridge:doctor") handler = command.handler;
    },
    sendMessage,
  } as unknown as ExtensionAPI;
  const pluginDir = path.join(directory, "missing-plugin");
  const bridge = new Bridge(pi, new CliDriver());
  bridge.start();
  assert.ok(bridge.driver instanceof CliDriver);
  await assert.rejects(bridge.driver.installPlugin(pluginDir), /manifest not found/);

  assert.ok(handler);
  await handler();

  assert.equal(sendMessage.mock.callCount(), 1);
  const [message, options] = sendMessage.mock.calls[0]!.arguments;
  assert.equal(message.customType, "pi-agy-bridge:doctor");
  assert.equal(message.display, true);
  assert.match(message.content, /Antigravity CLI plugin manifest not found/);
  assert.match(message.content, /Auth:/);
  assert.deepEqual(options, { triggerTurn: false });
});

test("doctor clears the recorded installation error after successful installation", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agy-doctor-recovery-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.rm(home, { recursive: true, force: true });
  });
  const pluginDir = DEFAULT_AGY_PLUGIN_DIR;
  const manifest: { version: string } = JSON.parse(await fs.readFile(path.join(pluginDir, "plugin.json"), "utf8"));
  const agyPath = path.join(home, "agy");
  await writeFile(agyPath, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.2.14; else echo "install denied" >&2; exit 7; fi\n', { mode: 0o755 });
  let handler: (() => Promise<void>) | undefined;
  const sendMessage = t.mock.fn();
  const pi = {
    on: () => {}, registerProvider: () => {}, sendMessage,
    registerCommand: (name: string, command: { handler: () => Promise<void> }) => {
      if (name === "agy-bridge:doctor") handler = command.handler;
    },
  } as unknown as ExtensionAPI;
  const bridge = new Bridge(pi, new CliDriver());
  t.mock.method(bridge.driver, "detectExecutable", () => agyPath);
  bridge.start();
  assert.ok(bridge.driver instanceof CliDriver);
  await assert.rejects(bridge.driver.installPlugin(pluginDir), /install denied/);
  assert.ok(handler);
  await handler();
  assert.match(sendMessage.mock.calls[0]!.arguments[0].content, /! plugin .*install denied/s);

  await writeFile(agyPath, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.2.14; fi\n');
  await bridge.driver.installPlugin(pluginDir);
  await handler();

  const report = sendMessage.mock.calls[1]!.arguments[0].content;
  assert.ok(report.includes(`✓ Antigravity CLI 1.2.14 (Plugin ${manifest.version})`));
  assert.doesNotMatch(report, /! plugin \(/);
  assert.match(report, /! usage \(/);
});
