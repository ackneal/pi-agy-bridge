import { test, mock } from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { loginAgyAuthentication } from "./auth.ts";

const url = "https://accounts.google.com/o/oauth2/auth?state=opaque";
const instructions = `Authentication required. Please visit the URL to log in:\n${url}\nOr, paste the authorization code here and press Enter:`;

for (const row of [
  { name: "preflight unknown never launches PTY", preflightUnknown: true, stream: "stderr", output: `${url} private-code\n`, error: /returned no quota data/ },
  { name: "BSD script requires real PTY", scriptFailure: true, stream: "stderr", output: `script: tcgetattr/ioctl: Operation not supported on socket\n${url} private-code\n`, error: /Could not start an interactive terminal for Antigravity CLI authentication/ },
  { name: "manual code", stream: "stderr", output: instructions, code: "private-code" },
  { name: "fragmented manual code echo alone cannot confirm status", stream: "stdout", output: instructions, code: "abcQuota123", echo: true, echoOnly: true, error: /Could not determine Antigravity CLI authentication status/ },
  { name: "report after fragmented manual code echo confirms status", stream: "stdout", output: instructions, code: "abcQuota123", echo: true },
  { name: "instructions split across streams", stream: "stderr", output: "Authentication required. Please visit the URL to log in:\n", splitStreams: true, code: "private-code" },
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
    const result = loginAgyAuthentication(interaction, "/fake/agy");
    const checked = "error" in row ? assert.rejects(result, (error: Error) => {
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
