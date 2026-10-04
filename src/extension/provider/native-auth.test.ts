import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { parseModelsOutput } from "../discovery/models.ts";
import { BridgeIPC } from "../bridge/bridge-ipc.ts";
import { AgyRuntime } from "../runtime/process.ts";
import { AgyBridge, registerAgyProvider } from "./provider.ts";

for (const scenario of ["native logout and relogin", "native URL and code login", "cancelled login", "headless unknown never retries"] as const) {
  test(scenario, async (t) => {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-native-auth-"));
    t.after(async () => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
    });
    const executable = path.join(directory, "agy");
    await writeFile(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo 1.2.16\nelse\n  exit 1\nfi\n', { mode: 0o755 });
    const children = new Map<number, EventEmitter>();
    const writes: string[] = [];
    let authenticated = true;
    let processCount = 0;
    let started: (() => void) | undefined;
    const processStarted = new Promise<void>((resolve) => { started = resolve; });
    let closed: (() => void) | undefined;
    const processClosed = new Promise<void>((resolve) => { closed = resolve; });
    t.mock.method(cp, "spawn", (command: string, args: string[]) => {
      assert.ok(command === executable || command === "/bin/sh");
      if (command === executable) assert.deepEqual(args, ["--print", "/usage"]);
      else {
        const invocation = args.join(" ");
        assert.match(invocation, /--print[' ]+[' ]*\/usage/);
        assert.ok(!invocation.includes("--disable-slash-commands"));
        assert.ok(!invocation.includes("--model"));
      }
      assert.ok(!args.some((arg) => /logout/i.test(arg)));
      const pid = 900_000_000 + ++processCount;
      const input = new PassThrough();
      const output = new PassThrough();
      const errors = new PassThrough();
      const control = new PassThrough();
      const gate = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        pid, stdout: output, stderr: errors, stdin: input,
        stdio: [input, output, errors, control, gate], kill: () => true,
      });
      children.set(pid, child);
      child.once("close", () => { children.delete(pid); });
      const finish = () => {
        output.write(scenario === "headless unknown never retries" ? "  Quota:  \r\n  Limit Remaining 100%\r\n" : "Quota:\n  Limit Remaining 100%\n");
        children.delete(pid);
        child.emit("close", 0, null);
      };
      input.on("data", (data) => {
        writes.push(data.toString());
        if (scenario === "native URL and code login") {
          assert.equal(data.toString(), "authorization-code\n");
          authenticated = true;
          assert.equal(input.writableEnded, false, "interactive PTY input remains writable");
          queueMicrotask(finish);
        }
      });
      gate.on("data", (data) => {
        assert.equal(data.toString(), "start\n");
        errors.write("Authentication required. Please visit the URL to log in:\nhttps://accounts.google.com/o/oauth2/auth?state=test\nOr, paste the authorization code here and press Enter:");
      });
      queueMicrotask(() => {
        started?.();
        if (scenario === "cancelled login") return;
        if (command === "/bin/sh") {
          control.write(`${pid + 10_000} ${pid + 10_000}\n`);
          return;
        }
        if (scenario === "native URL and code login" && processCount === 1) {
          errors.write("Authentication required\n");
          return;
        }
        assert.equal(input.writableEnded, true, "probes close stdin without a model request");
        if (scenario === "headless unknown never retries") {
          child.emit("close", 0, null);
          return;
        }
        if (authenticated) finish();
        else child.stderr.write("Error: authentication required. Run agy to log in.\n");
      });
      return child;
    });
    t.mock.method(cp, "spawnSync", (command: string, args: string[]) => {
      assert.equal(command, "/bin/ps");
      assert.deepEqual(args, ["-o", "pgid=", "-p", String(process.pid)]);
      return { status: 0, stdout: `${process.pid}\n`, stderr: "" };
    });
    t.mock.method(process, "kill", (pid: number) => {
      const child = children.get(-pid);
      if (child) {
        children.delete(-pid);
        queueMicrotask(() => { child.emit("close", null, "SIGTERM"); closed?.(); });
      }
      return true;
    });
    syncBuiltinESMExports();
    const runtime = await ModelRuntime.create({
      modelsPath: null, authPath: path.join(directory, "auth.json"), refreshOnCreate: false,
    });
    let provider: Provider | undefined;
    const commands: string[] = [];
    const models = parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)");
    registerAgyProvider({
      on: () => {}, registerCommand: (name: string) => commands.push(name),
      getActiveTools: () => [], getAllTools: () => [],
      registerProvider: (registered: Provider) => {
        provider = registered;
        runtime.registerNativeProvider(registered);
      },
    } as unknown as ExtensionAPI, { models, agyPath: executable, authPath: path.join(directory, "auth.json") });
    await runtime.refresh({ providers: ["agy"], allowNetwork: false });
    assert.ok(provider?.auth.oauth?.login);
    assert.equal(provider.auth.oauth.isSubscription, true);
    assert.deepEqual(commands, ["agy-bridge:doctor"]);
    assert.deepEqual(await runtime.getAvailable("agy"), []);
    assert.equal(processCount, 0, "availability checks must not launch authentication");
    const controller = new AbortController();
    const progress: string[] = [];
    const interaction = {
      signal: controller.signal,
      notify: (event: { type: string; url?: string; message?: string }) => {
        if (event.type === "progress") {
          progress.push(event.message ?? "");
          return;
        }
        assert.equal(scenario, "native URL and code login");
        if (event.type === "auth_url") assert.equal(event.url, "https://accounts.google.com/o/oauth2/auth?state=test");
      },
      prompt: async (request: { type: string }) => {
        assert.equal(scenario, "native URL and code login");
        assert.equal(request.type, "manual_code");
        return "authorization-code";
      },
    };
    const login = runtime.login("agy", "oauth", interaction);

    if (scenario === "cancelled login") {
      const rejected = assert.rejects(login);
      await processStarted;
      assert.match(progress[0] ?? "", /Checking Antigravity CLI authentication status/);
      controller.abort();
      await rejected;
      await processClosed;
      assert.deepEqual(await runtime.listCredentials(), []);
      assert.deepEqual(await runtime.getAvailable("agy"), []);
      assert.equal(children.size, 0);
      assert.deepEqual(writes, []);
      return;
    }

    if (scenario === "headless unknown never retries") {
      await assert.rejects(login, /Could not determine Antigravity CLI authentication status \(exitCode=0, signal=none, stdoutBytes=0, stderrBytes=0\)/);
      assert.equal(processCount, 1, "unknown status must not launch a PTY retry");
      assert.deepEqual(await runtime.listCredentials(), []);
      assert.deepEqual(await runtime.getAvailable("agy"), []);
      assert.deepEqual(writes, []);
      return;
    }

    const credential = await login;
    assert.match(progress[0] ?? "", /Checking Antigravity CLI authentication status/);
    assert.ok(credential.type === "oauth");
    assert.equal(credential.access, "");
    assert.equal(credential.refresh, "");
    assert.equal(credential.agyBridge, true);
    assert.match(String(credential.loginEpoch), /^[0-9a-f-]{36}$/);
    assert.equal(runtime.isUsingSubscription("agy"), true);
    assert.equal((await runtime.getAvailable("agy")).length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "auth.json"), "utf8")), { agy: credential });
    assert.deepEqual(await runtime.listCredentials(), [{ providerId: "agy", type: "oauth" }]);
    await runtime.logout("agy");
    assert.deepEqual(await runtime.getAvailable("agy"), []);
    assert.equal(runtime.isUsingSubscription("agy"), false);
    assert.equal(authenticated, true, "Pi logout must leave Antigravity CLI's external login untouched");
    const countBeforeDisabledRequest = processCount;
    const disabled = await runtime.streamSimple(models[0]!, { messages: [] }, { sessionId: "auth-test" }).result();
    assert.equal(disabled.stopReason, "error");
    assert.match(disabled.errorMessage ?? "", /not configured/);
    assert.equal(processCount, countBeforeDisabledRequest, "disabled requests must not launch Antigravity CLI");

    const relogin = await runtime.login("agy", "oauth", interaction);
    assert.ok(relogin.type === "oauth");
    assert.notEqual(relogin.loginEpoch, credential.loginEpoch);
    assert.equal((await runtime.getAvailable("agy")).length, 1);
    authenticated = false;
    const countBeforeExpiredRequest = processCount;
    t.mock.method(BridgeIPC.prototype, "start", async () => {});
    t.mock.method(BridgeIPC.prototype, "close", async () => {});
    t.mock.getter(BridgeIPC.prototype, "processEnvironment", () => ({}));
    t.mock.method(AgyBridge.prototype, "ensureAgyPluginInstalled", async () => {});
    const startRuntime = t.mock.method(AgyRuntime.prototype, "start", async () => {
      throw new Error("Authentication required. Run agy to log in.");
    });
    const expired = await runtime.streamSimple(models[0]!, { messages: [] }, { sessionId: "auth-test" }).result();
    assert.equal(expired.stopReason, "error");
    assert.match(expired.errorMessage ?? "", /Authentication required/);
    assert.equal(startRuntime.mock.callCount(), 1, "expired login must be reported by the runtime, not an auth probe");
    assert.equal(processCount, countBeforeExpiredRequest, "requests must not launch a separate authentication process");
    assert.equal((await runtime.getAvailable("agy")).length, 1,
      "configured models remain selectable even when Antigravity CLI authentication expires");
    assert.deepEqual(writes, scenario === "native URL and code login" ? ["authorization-code\n"] : [],
      "authentication may only send an authorization code, never a user/model request");
    assert.equal(children.size, 0);
  });
}
