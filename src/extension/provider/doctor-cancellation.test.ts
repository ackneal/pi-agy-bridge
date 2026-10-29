import { beforeEach } from "node:test";
import { useAuthHomeFixture } from "./auth-home-fixture.ts";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";

useAuthHomeFixture();

// version.ts captures the promisified function at import time; keep its dispatcher reusable.
let execute: (args: readonly string[], signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>;

test("doctor suppresses reports after shutdown at each await boundary", async (t) => {
  const replacement = Object.assign(() => {}, {
    [promisify.custom]: (_file: string, args: readonly string[], options: { signal?: AbortSignal }) => execute(args, options.signal),
  });
  const original = cp.execFile;
  cp.execFile = replacement as unknown as typeof cp.execFile;
  syncBuiltinESMExports();
  t.after(() => { cp.execFile = original; syncBuiltinESMExports(); });
  const { CliDriver } = await import("../drivers/cli/driver.ts");
  const { fetchAgyUsage } = await import("../runtime/usage.ts");
  const { Bridge } = await import("./provider.ts");

  for (const stage of ["quota", "report"] as const) {
    await t.test(stage, async (t) => {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      t.after(() => release());
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
  const { CliDriver } = await import("../drivers/cli/driver.ts");
  const { fetchAgyUsage } = await import("../runtime/usage.ts");
  const { Bridge } = await import("./provider.ts");
  const controller = new AbortController();
  const pending: Promise<unknown>[] = [];
  const children: ReturnType<typeof createChild>[] = [];
  function createChild(pid: number) {
    return Object.assign(new EventEmitter(), {
      pid,
      stdout: new PassThrough(), stderr: new PassThrough(), closed: false,
    });
  }
  const close = (child: typeof children[number], quota?: string) => {
    if (child.closed) return;
    if (quota) child.stdout.write(`Claude  Five hour  ${quota}%`);
    child.closed = true;
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", quota ? 0 : null, quota ? null : "SIGKILL");
    child.emit("close", quota ? 0 : null, quota ? null : "SIGKILL");
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
