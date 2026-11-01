import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { loginAgyAuthentication, probeAgyAuthentication } from "./auth.ts";
import type { AgyUsage } from "./usage.ts";
import { AuthenticationRequiredError } from "../shared/types.ts";

const url = "https://accounts.google.com/o/oauth2/auth?state=opaque";
const instructions = `Authentication required. Please visit the URL to log in:\n${url}\nOr, paste the authorization code here and press Enter:`;

for (const row of [
  { name: "preflight unknown never launches PTY", preflightUnknown: true, stream: "stderr", output: `${url} private-code\n`, error: /returned no quota data/ },
  { name: "BSD script requires real PTY", scriptFailure: true, stream: "stderr", output: `script: tcgetattr/ioctl: Operation not supported on socket\n${url} private-code\n`, error: /Could not start an interactive terminal for Antigravity CLI authentication/ },
  { name: "manual code", stream: "stderr", output: instructions, code: "private-code" },
  { name: "fragmented manual code echo alone cannot confirm status", stream: "stdout", output: instructions, code: "abcQuota123", echo: true, echoOnly: true, error: /Could not determine Antigravity CLI authentication status/ },
  { name: "report after fragmented manual code echo confirms status", stream: "stdout", output: instructions, code: "abcQuota123", echo: true },
  { name: "instructions split across streams", stream: "stderr", output: "Authentication required. Please visit the URL to log in:\n", splitStreams: true, code: "private-code" },
  { name: "interactive valid usage callback rejects login", stream: "stdout", output: instructions, browser: true, callbackThrows: true },
  { name: "browser wins pending prompt", stream: "stdout", output: instructions, browser: true },
  { name: "invalid code", stream: "stdout", output: instructions, code: "private\ncode", error: /Invalid authorization code/ },
  { name: "code cannot forge init through PTY echo", stream: "stdout", output: instructions, code: '{"event":"init"}', error: /Invalid authorization code/ },
  { name: "failed code closes", stream: "stdout", output: instructions, code: "failed-code", failCode: true, error: /Could not determine Antigravity CLI authentication status/ },
  { name: "invalid URL", stream: "stderr", output: instructions.replace("accounts.google.com", "evil.example"), error: /Antigravity CLI returned an untrusted authentication URL/ },
  { name: "interactive cancel terminates", stream: "stdout", output: "", cancel: true, error: /Antigravity CLI authentication was cancelled/ },
  { name: "interactive timeout escalates kill", stream: "stdout", output: "", timeout: true, error: /Timed out waiting for Antigravity CLI authorization/ },
] as const) {
  test(row.name, async (t) => {
    const controller = new AbortController();
    const writes: string[] = [];
    const progress: string[] = [];
    const signals: string[] = [];
    const gates: string[] = [];
    const roots = new Map<number, typeof children[number]>();
    const targets = new Map<number, typeof children[number]>();
    const children: Array<{ child: ReturnType<typeof createChild>; closed: boolean }> = [];
    let promptSignal: AbortSignal | undefined;
    let late: ((code: string) => void) | undefined;
    function createChild() {
      const stdio = [new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough()] as const;
      return Object.assign(new EventEmitter(), { stdout: stdio[1], stderr: stdio[2], stdin: stdio[0], stdio, pid: 123456789 + children.length * 2, kill: () => true });
    }
    const close = (entry: typeof children[number], code = 0) => {
      if (entry.closed) return;
      entry.closed = true;
      entry.child.emit("close", code, null);
    };
    t.after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
    mock.method(cp, "spawnSync", () => ({ stdout: "987654\n", stderr: "", status: 0, signal: null, pid: 987654, output: [null, "987654\n", ""] }));
    mock.method(cp, "spawn", (command: string, argv: string[], options: cp.SpawnOptions) => {
      const preflight = children.length === 0;
      const interactive = !preflight;
      assert.equal(command, interactive ? "/bin/sh" : "/fake/agy");
      assert.equal(options.detached, true);
      assert.deepEqual(options.stdio, interactive ? ["pipe", "pipe", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"]);
      if (!interactive) assert.deepEqual(argv, ["--output-format", "json", "--print", "/usage"]);
      else {
        const invocation = argv.join(" ");
        assert.ok(invocation.includes("--print"));
        assert.ok(invocation.includes("/usage"));
        assert.ok(!invocation.includes("--disable-slash-commands"));
      }

      const entry = { child: createChild(), closed: false };
      children.push(entry);
      const { child } = entry;
      roots.set(child.pid, entry);
      if (interactive) {
        targets.set(child.pid + 1, entry);
        child.stdio[4].on("data", (data) => gates.push(data.toString()));
      }
      child.stdin.on("data", (data) => {
        assert.deepEqual(progress, ["Completing Antigravity CLI authentication"], "show progress before forwarding the code");
        writes.push(data.toString());
        if ("echo" in row) {
          for (const char of "abc\x1b[32mQuota\x1b[0m123\r\n") child.stdout.write(char);
        }
        if ("echoOnly" in row) close(entry);
        else if ("failCode" in row) close(entry, 1);
        else { child.stdout.write("\r\nQuota:\nGemini Models  Weekly Limit Remaining 97%\n"); close(entry); }
      });
      queueMicrotask(() => {
        if (preflight) {
          if ("preflightUnknown" in row) child.stdout.write("unknown");
          else child.stderr.write("Authentication required\n");
          close(entry); return;
        }
        if (!("scriptFailure" in row)) child.stdio[3].write(`${child.pid + 1} ${child.pid + 1}\n`);
        for (const char of row.output) child[row.stream].write(char);
        if ("splitStreams" in row) child.stdout.write(`${url}\nOr, paste the authorization code here and press Enter:`);
        if ("browser" in row) { child.stderr.write("Quota:\r\nGemini Models  Weekly Limit Remaining 97%\r\n"); close(entry); }
        if ("cancel" in row) controller.abort();
        if ("preflightUnknown" in row || "scriptFailure" in row) close(entry, 1);
      });
      return child;
    });
    mock.method(process, "kill", (pid: number, signal: string) => {
      const entry = roots.get(Math.abs(pid)) ?? targets.get(Math.abs(pid));
      assert.ok(entry, `unexpected kill target ${pid}`);
      if (roots.has(Math.abs(pid)) && entry.closed) {
        assert.ok(pid < 0, "must not signal an exited root process directly");
        throw Object.assign(new Error("Process group no longer exists"), { code: "ESRCH" });
      }
      signals.push(signal);
      if (roots.has(Math.abs(pid)) && (!("timeout" in row) || signal === "SIGKILL")) queueMicrotask(() => close(entry));
      return true;
    });
    syncBuiltinESMExports();
    if ("timeout" in row) {
      t.mock.timers.enable({ apis: ["setTimeout"] });
    }
    const interaction: ProviderAuthInteraction = {
      signal: controller.signal,
      notify(event) {
        if (event.type === "auth_url") assert.equal(event.url, url);
        if (event.type === "progress") progress.push(event.message);
      },
      prompt(request) {
        assert.equal(request.type, "manual_code");
        promptSignal = request.signal;
        if ("browser" in row) return new Promise((resolve) => { late = resolve; });
        assert.ok("code" in row, "unexpected prompt");
        return Promise.resolve(row.code);
      },
    };
    const callbackError = new Error("usage callback failed");
    let usageCalls = 0;
    const result = loginAgyAuthentication(interaction, "/fake/agy", "callbackThrows" in row ? (usage) => {
      assert.ok(usage);
      usageCalls++;
      throw callbackError;
    } : undefined);
    const checked = "callbackThrows" in row ? assert.rejects(result, (error) => error === callbackError) : "error" in row ? assert.rejects(result, (error: Error) => {
      assert.ok(row.error);
      assert.match(error.message, row.error);
      assert.doesNotMatch(error.message, /status unknown|exit code/);
      if (error.message.startsWith("Could not determine Antigravity CLI authentication status")) {
        assert.match(error.message, /^Could not determine Antigravity CLI authentication status \(exitCode=(?:\d+|none), signal=(?:SIGTERM|none), stdoutBytes=\d+, stderrBytes=\d+\)/);
      }
      for (const secret of [url, "private-code", "failed-code", "late-secret"]) assert.ok(!error.message.includes(secret));
      return true;
    }) : result.then((value) => {
      assert.equal(value, undefined);
    });
    if ("timeout" in row) {
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
      t.mock.timers.tick(180_000);
      t.mock.timers.tick(500);
    }
    await checked;
    assert.equal(usageCalls, "callbackThrows" in row ? 1 : 0);
    assert.equal(children.length, "preflightUnknown" in row ? 1 : 2);
    for (const { child, closed } of children) {
      assert.equal(child.stdin.writableEnded, false);
      assert.equal(closed, true);
      assert.equal(child.listenerCount("close"), 0);
      assert.equal(child.listenerCount("error"), 0);
      assert.equal(child.stdout.listenerCount("data"), 0);
      assert.equal(child.stderr.listenerCount("data"), 0);
      assert.equal(child.stdio[3].listenerCount("data"), 0);
      if (targets.has(child.pid + 1)) {
        assert.equal(child.stdio[3].destroyed, true);
        assert.equal(child.stdio[4].destroyed, true);
      }
    }
    if ("browser" in row) {
      assert.equal(promptSignal?.aborted, true);
      late?.("late-secret");
      await Promise.resolve();
    }
    assert.deepEqual(gates, children.length === 2 && !("scriptFailure" in row) ? ["start\n"] : []);
    assert.deepEqual(writes, "code" in row && !("error" in row && !("failCode" in row) && !("echoOnly" in row)) ? [`${row.code}\n`] : []);
    assert.deepEqual(progress, writes.length ? ["Completing Antigravity CLI authentication"] : [],
      "invalid, cancelled, browser-completed and cached login must not show code-submission progress");
    if ("timeout" in row) {
      assert.ok(signals.includes("SIGTERM"));
      assert.ok(signals.includes("SIGKILL"));
    }
  });
}

// --- Merged from auth-command.test.ts ---
test("cached login requests JSON usage once without input or PTY", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agy-auth-cmd-"));
  const executable = join(directory, "agy");
  const record = join(directory, "record.json");
  const spawn = cp.spawn;
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), input, noTTY: !process.stdin.isTTY && !process.stdout.isTTY && !process.stderr.isTTY }));
  process.stdout.write('Quota:\\nGemini Models  Weekly Limit Remaining 97%\\n');
}, 25);
`, { mode: 0o755 });
  const invocation = t.mock.method(cp, "spawn", (...args: Parameters<typeof cp.spawn>) => {
    assert.equal(args[0], executable, "cached login must not launch script");
    assert.deepEqual(args[1], ["--output-format", "json", "--print", "/usage"]);
    return spawn(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  await loginAgyAuthentication({
    signal: new AbortController().signal,
    notify() { assert.fail("cached login must not notify"); },
    prompt() { assert.fail("cached login must not prompt"); },
  }, executable);

  assert.equal(invocation.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(await readFile(record, "utf8")), {
    args: ["--output-format", "json", "--print", "/usage"],
    input: "",
    noTTY: true,
  });
});

// --- Merged from auth-probe.test.ts ---
describe("probeAgyAuthentication", () => {
  const groups = [{
    name: "Pro",
    buckets: [{ id: "pro-5h", name: "Five Hour", window: "5h", remainingFraction: 0.75 }],
  }];
  const text = "Quota\nPro  Five Hour  75%\n";
  const emit = (output: string) => `process.stdout.write(${JSON.stringify(output)});`;
  const callbackError = new Error("usage consumer failed");
  const callbackAuthError = new AuthenticationRequiredError();

  type Row = {
    name: string;
    script?: string;
    result?: boolean;
    error?: RegExp | Error;
    callbackError?: Error;
    aborted?: boolean;
  };

  const rows: Row[] = [
    { name: "parsed text succeeds and reports usage once", script: emit(text), result: true },
    { name: "unrecognized output throws", script: emit("report unavailable"), error: /returned no quota data/ },
    { name: "nonzero exit with valid quota throws", script: `${emit(text)} process.exitCode = 7;`, error: /process failed \(exit 7\)/ },
    { name: "explicit authentication requirement returns false", script: emit("Authentication required"), result: false },
    { name: "OAuth URL alone is not an authentication verdict", script: emit("Open https://example.test/oauth"), error: /returned no quota data/ },
    { name: "login suggestion alone is not an authentication verdict", script: `${emit("Please run login")} process.exitCode = 1;`, error: /process failed \(exit 1\)/ },
    { name: "authorization code prompt alone is not an authentication verdict", script: emit("Enter authorization code:"), error: /returned no quota data/ },
    { name: "already aborted signal throws without spawning", aborted: true },
    { name: "callback error propagates", script: emit(text), callbackError, error: callbackError },
    { name: "callback authentication error propagates instead of returning false", script: emit(text), callbackError: callbackAuthError, error: callbackAuthError },
  ];

  for (const row of rows) {
    test(`probeAgyAuthentication: ${row.name}`, { timeout: 3000, skip: process.platform === "win32" }, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "agy-auth-probe-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const executable = join(directory, "agy");
      await writeFile(executable, `#!${process.execPath}\n${row.script ?? ""}\n`, { mode: 0o755 });

      const controller = new AbortController();
      const abortReason = new Error("probe already cancelled");
      if (row.aborted) controller.abort(abortReason);
      const spawn = row.aborted ? t.mock.method(cp, "spawn") : undefined;
      const watchdog = setTimeout(() => controller.abort(new Error("probe did not settle promptly")), 2000);
      t.after(() => clearTimeout(watchdog));
      const usages: AgyUsage[] = [];
      const probe = probeAgyAuthentication(executable, controller.signal, (usage) => {
        usages.push(usage);
        if (row.callbackError) throw row.callbackError;
      });

      const expectedError = row.aborted ? abortReason : row.error;
      if (expectedError instanceof Error) {
        await assert.rejects(probe, (error) => error === expectedError);
      } else if (expectedError) {
        await assert.rejects(probe, expectedError);
      } else {
        assert.equal(await probe, row.result);
      }

      if (spawn) assert.equal(spawn.mock.callCount(), 0);
      const expectsUsage = row.result === true || row.callbackError !== undefined;
      assert.equal(usages.length, expectsUsage ? 1 : 0);
      if (expectsUsage) {
        assert.deepEqual(usages[0]!.groups, groups);
        assert.ok(Number.isFinite(Date.parse(usages[0]!.updatedAt)));
      }
    });
  }
});

// --- Merged from auth-descendants.test.ts ---
describe("probeAgyAuthentication descendant termination", () => {
  async function waitFor(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await delay(10);
    }
    assert.fail(message);
  }

  function gone(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
  }

  async function readPid(path: string): Promise<number | undefined> {
    try {
      const pid = Number(await readFile(path, "utf8"));
      return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  function kill(pid: number): void {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  for (const row of [
    { name: "natural root completion kills a SIGTERM-ignoring child with ignored stdio", cancel: false, exitFirst: true, stdio: "ignore" },
    { name: "cancellation kills a SIGTERM-ignoring child after the root exits with ignored stdio", cancel: true, exitFirst: false, stdio: "ignore" },
    { name: "natural root completion kills a SIGTERM-ignoring child holding inherited stdio", cancel: false, exitFirst: true, stdio: "inherit" },
  ] as const) {
    test(`probeAgyAuthentication: ${row.name}`, { skip: process.platform === "win32", timeout: 15000 }, async () => {
      const directory = await mkdtemp(join(tmpdir(), "agy-auth-descendants-"));
      const executable = join(directory, "agy.cjs");
      const rootFile = join(directory, "root.pid");
      const childFile = join(directory, "child.pid");
      const exitFile = join(directory, "exit");
      const controller = new AbortController();
      let rootPid: number | undefined;
      let childPid: number | undefined;
      let result: { value: boolean } | { error: unknown } | undefined;
      let probe: Promise<void> | undefined;

      try {
        const childSource = `
          const { writeFileSync } = require("node:fs");
          process.on("SIGTERM", () => {});
          setInterval(() => {}, 1000);
          writeFileSync(${JSON.stringify(childFile)}, String(process.pid));
        `;
        await writeFile(executable, `#!${process.execPath}
const { spawn } = require("node:child_process");
const { writeFileSync, existsSync } = require("node:fs");
process.on("SIGTERM", () => process.exit(0));
writeFileSync(${JSON.stringify(rootFile)}, String(process.pid));
spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: ${JSON.stringify(row.stdio)} });
const gate = setInterval(() => {
  if (!existsSync(${JSON.stringify(exitFile)})) return;
  clearInterval(gate);
  process.stdout.write(JSON.stringify({ response: "Gemini Models  Weekly Limit Remaining 97%" }), () => process.exit(0));
}, 10);
`, { mode: 0o755 });

        probe = probeAgyAuthentication(executable, controller.signal).then(
          (value) => { result = { value }; },
          (error: unknown) => { result = { error }; },
        );
        await waitFor(async () => {
          rootPid = await readPid(rootFile);
          childPid = await readPid(childFile);
          return rootPid !== undefined && childPid !== undefined;
        }, "fixture did not publish root and ready child PIDs");
        assert.ok(rootPid);
        assert.ok(childPid);
        assert.equal(gone(rootPid), false, "root must be alive before the exit/cancel trigger");
        assert.equal(gone(childPid), false, "ready child must be alive before the exit/cancel trigger");

        if (row.exitFirst) {
          await writeFile(exitFile, "exit");
          await waitFor(() => gone(rootPid!), "root did not exit after the explicit gate");
        }
        if (row.cancel) controller.abort();

        await waitFor(() => result !== undefined, "probe did not settle after cancellation/root exit (inherited stdio remained open)");
        assert.ok(result);
        if (row.cancel) {
          assert.ok("error" in result, "cancelled probe must reject");
          assert.ok(result.error instanceof Error);
          assert.match(result.error.message, /abort|cancel/i);
        } else {
          assert.deepEqual(result, { value: true });
        }
        await waitFor(() => gone(rootPid!), "root survived cancellation");
        await waitFor(() => gone(childPid!), `descendant ${childPid} survived root completion/cancellation (or was not reaped)`);
      } finally {
        controller.abort();
        rootPid ??= await readPid(rootFile);
        childPid ??= await readPid(childFile);
        try {
          if (rootPid) kill(-rootPid);
          if (childPid) kill(childPid);
          if (rootPid) kill(rootPid);
          if (probe) {
            await waitFor(() => result !== undefined, "probe did not settle during fixture cleanup");
            await probe;
          }
          if (rootPid) await waitFor(() => gone(rootPid!), "root was not reaped during cleanup");
          if (childPid) await waitFor(() => gone(childPid!), "descendant was not reaped during cleanup");
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    });
  }
});
