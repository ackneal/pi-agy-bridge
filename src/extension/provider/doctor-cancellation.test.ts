import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("doctor suppresses reports after shutdown at each await boundary", async (t) => {
  let execute: (args: readonly string[], signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>;
  const replacement = Object.assign(() => {}, {
    [promisify.custom]: (_file: string, args: readonly string[], options: { signal?: AbortSignal }) => execute(args, options.signal),
  });
  const original = cp.execFile;
  cp.execFile = replacement as unknown as typeof cp.execFile;
  syncBuiltinESMExports();
  t.after(() => { cp.execFile = original; syncBuiltinESMExports(); });
  const { AgyBridge } = await import("./provider.ts");

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
        registerCommand: (_name: string, command: { handler: () => Promise<void> }) => { doctor = command.handler; },
        on: (name: string, handler: () => Promise<void>) => { if (name === "session_shutdown") shutdown = handler; },
        registerProvider: () => {},
        sendMessage,
      } as unknown as ExtensionAPI;
      const bridge = new AgyBridge(pi, { models: [], agyPath: "/fake/agy", pluginDir: "/missing/doctor-plugin" });
      bridge.start();
      assert.ok(doctor);
      assert.ok(shutdown);

      const pending = doctor();
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
