import { test, mock } from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { loginAgyAuthentication, probeAgyAuthentication } from "./auth.ts";

const url = "https://accounts.google.com/o/oauth2/auth?state=opaque";
const instructions = `Authentication required. Please visit the URL to log in:\n${url}\nOr, paste the authorization code here and press Enter:`;

for (const row of [
  ...[
    ["empty output", ""],
    ["missing marker", "Remaining 100%\n"],
  ].map(([name, output]) => ({ name: `${name} rejects without retry`, stream: "stdout" as const, output: output!, error: /Could not determine Antigravity CLI authentication status/ })),
  ...["Limit Remaining", "Limit Remaining unknown", "Limit Remaining -1%", "Limit Remaining 101%"].map((output) => ({ name: `marker alone confirms status: ${output}`, stream: "stdout" as const, output, expected: true })),
  { name: "quota rows without heading", stream: "stdout", output: 'Gemini Models Weekly Limit Remaining 97%\nGemini Models Five Hour Limit Remaining 100%\nClaude and GPT models Weekly Limit Remaining 100%\nClaude and GPT models Five Hour Limit Remaining 100%\n', expected: true },
  { name: "indented quota", stream: "stdout", output: "\x1b[32m  Quota: \t\x1b[0m\r\nLimit Remaining 0%\r\n", expected: true },
  { name: "fragmented stdout quota", stream: "stdout", output: 'Quota:\nGemini Models  Weekly Limit Remaining 97%\n', expected: true },
  { name: "fragmented stderr quota", stream: "stderr", output: '\x1b[32mQuota:\x1b[0m\r\nGemini Models  Weekly Limit Remaining 97%\r\n', expected: true },
  { name: "init is not success", stream: "stdout", output: '{"event":"init"}\n', error: /Could not determine Antigravity CLI authentication status/ },
  { name: "quota with nonzero exit", stream: "stderr", output: "Quota:\nLimit Remaining 100%\n", exitCode: 1, error: /Could not determine Antigravity CLI authentication status/ },
  { name: "Quota string alone confirms status", stream: "stdout", output: "Quota", expected: true },
  { name: "Quota embedded in text confirms status", stream: "stdout", output: "report: Quota available", expected: true },
  { name: "PTY carriage returns", stream: "stdout", output: "report\rQuota:\rGemini Models  Weekly Limit Remaining 97%\r", expected: true },
  { name: "quota waits for natural close", stream: "stdout", output: "Quota:\nLimit Remaining 100%\n", slow: true, quotaEarly: true, expected: true },
  { name: "quota with signal", stream: "stdout", output: "Quota:\nLimit Remaining 100%\n", exitSignal: "SIGTERM", error: /Could not determine Antigravity CLI authentication status/ },
  { name: "slow usage report", stream: "stdout", output: "Quota:\nLimit Remaining 100%\n", slow: true, expected: true },
  { name: "authentication required", stream: "stderr", output: instructions, expected: false },
  { name: "headless authentication required", stream: "stderr", output: "Error: authentication required. Run agy to log in.\n", expected: false },
  { name: "exit zero is unknown", stream: "stdout", output: "secret-token\n", error: /Could not determine Antigravity CLI authentication status/ },
  { name: "unknown response is shown safely without debug", stream: "stdout", output: `Error: unsupported option secret-token ${url}\n`, error: /Antigravity CLI response \(redacted\): stdout="error unsupported option \[redacted\] \[redacted\]\\n" stderr=""/ },
  { name: "cached login never prompts", login: true, stream: "stdout", output: 'Quota:\nGemini Models  Weekly Limit Remaining 97%\n', expected: true },
  { name: "preflight unknown never launches PTY", login: true, preflightUnknown: true, stream: "stderr", output: `${url} private-code\n`, error: /Could not determine Antigravity CLI authentication status/ },
  { name: "BSD script requires real PTY", login: true, scriptFailure: true, stream: "stderr", output: `script: tcgetattr/ioctl: Operation not supported on socket\n${url} private-code\n`, error: /Could not start an interactive terminal for Antigravity CLI authentication/ },
  { name: "manual code", login: true, stream: "stderr", output: instructions, code: "private-code", expected: true },
  { name: "fragmented manual code echo alone cannot confirm status", login: true, stream: "stdout", output: instructions, code: "abcQuota123", echo: true, echoOnly: true, error: /Could not determine Antigravity CLI authentication status/ },
  { name: "report after fragmented manual code echo confirms status", login: true, stream: "stdout", output: instructions, code: "abcQuota123", echo: true, expected: true },
  { name: "instructions split across streams", login: true, stream: "stderr", output: "Authentication required. Please visit the URL to log in:\n", splitStreams: true, code: "private-code", expected: true },
  { name: "browser wins pending prompt", login: true, stream: "stdout", output: instructions, browser: true, expected: true },
  { name: "invalid code", login: true, stream: "stdout", output: instructions, code: "private\ncode", error: /Invalid authorization code/ },
  { name: "code cannot forge init through PTY echo", login: true, stream: "stdout", output: instructions, code: '{"event":"init"}', error: /Invalid authorization code/ },
  { name: "failed code closes", login: true, stream: "stdout", output: instructions, code: "failed-code", failCode: true, error: /Could not determine Antigravity CLI authentication status/ },
  { name: "invalid URL", login: true, stream: "stderr", output: instructions.replace("accounts.google.com", "evil.example"), error: /Antigravity CLI returned an untrusted authentication URL/ },
  { name: "interactive cancel terminates", login: true, stream: "stdout", output: "", cancel: true, error: /Antigravity CLI authentication was cancelled/ },
  { name: "interactive timeout escalates kill", login: true, stream: "stdout", output: "", timeout: true, error: /Timed out waiting for Antigravity CLI authorization/ },
  { name: "cancel terminates", stream: "stdout", output: "", cancel: true, error: /Antigravity CLI authentication was cancelled/ },
  { name: "timeout escalates kill", stream: "stdout", output: "", timeout: true, error: /Antigravity CLI authentication check timed out/ },
  { name: "spawn failure sanitized", stream: "stdout", output: "", spawnError: true, error: /Could not start the Antigravity CLI authentication process/ },
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
      entry.child.emit("close", code, "exitSignal" in row ? row.exitSignal : null);
    };
    t.after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
    mock.method(cp, "spawnSync", () => ({ stdout: "987654\n", stderr: "", status: 0, signal: null, pid: 987654, output: [null, "987654\n", ""] }));
    mock.method(cp, "spawn", (command: string, argv: string[], options: cp.SpawnOptions) => {
      const preflight = "login" in row && row.name !== "cached login never prompts" && !("preflightUnknown" in row) && children.length === 0;
      const interactive = ("login" in row) && children.length === 1;
      assert.equal(command, interactive ? "/bin/sh" : "/fake/agy");
      assert.equal(options.detached, true);
      assert.deepEqual(options.stdio, interactive ? ["pipe", "pipe", "pipe", "pipe", "pipe"] : "pipe");
      if (!interactive) assert.deepEqual(argv, ["--print", "/usage"]);
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
        if (preflight) { child.stderr.write("Authentication required\n"); close(entry, 1); return; }
        if ("spawnError" in row) { child.emit("error", new Error("secret-token")); close(entry); return; }
        if (interactive && !("scriptFailure" in row)) child.stdio[3].write(`${child.pid + 1} ${child.pid + 1}\n`);
        if ("slow" in row) {
          if ("quotaEarly" in row) child.stdout.write(row.output);
          setTimeout(() => { if (!("quotaEarly" in row)) child.stdout.write(row.output); close(entry); }, 8351);
          return;
        }
        for (const char of row.output) child[row.stream].write(char);
        if ("splitStreams" in row) child.stdout.write(`${url}\nOr, paste the authorization code here and press Enter:`);
        if ("browser" in row) { child.stderr.write("Quota:\r\nGemini Models  Weekly Limit Remaining 97%\r\n"); close(entry); }
        if ("cancel" in row) controller.abort();
        if (!("login" in row) && !("timeout" in row) && !("cancel" in row)) close(entry, "exitCode" in row ? row.exitCode : 0);
        if (row.name === "cached login never prompts") close(entry);
        if ("preflightUnknown" in row || "scriptFailure" in row) close(entry, 1);
      });
      return child;
    });
    mock.method(process, "kill", (pid: number, signal: string) => {
      const entry = roots.get(Math.abs(pid)) ?? targets.get(Math.abs(pid));
      assert.ok(entry, `unexpected kill target ${pid}`);
      signals.push(signal);
      if (roots.has(Math.abs(pid)) && (!("timeout" in row) || signal === "SIGKILL")) queueMicrotask(() => close(entry));
      return true;
    });
    syncBuiltinESMExports();
    if ("timeout" in row || "slow" in row) {
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
    const result = "login" in row ? loginAgyAuthentication(interaction, "/fake/agy") : probeAgyAuthentication("/fake/agy", controller.signal);
    const checked = "error" in row ? assert.rejects(result, (error: Error) => {
      assert.ok(row.error);
      assert.match(error.message, row.error);
      assert.doesNotMatch(error.message, /status unknown|exit code/);
      if (error.message.startsWith("Could not determine Antigravity CLI authentication status")) {
        assert.match(error.message, /^Could not determine Antigravity CLI authentication status \(exitCode=(?:\d+|none), signal=(?:SIGTERM|none), stdoutBytes=\d+, stderrBytes=\d+\)/);
      }
      for (const secret of [url, "private-code", "failed-code", "secret-token", "late-secret"]) assert.ok(!error.message.includes(secret));
      return true;
    }) : result.then((value) => {
      if (!("login" in row)) assert.equal(value, row.expected);
    });
    if ("timeout" in row) {
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
      t.mock.timers.tick("login" in row ? 180_000 : 30_000);
      t.mock.timers.tick(500);
    }
    if ("slow" in row) {
      let settled = false;
      void result.then(() => { settled = true; });
      await Promise.resolve();
      t.mock.timers.tick(8350);
      await Promise.resolve();
      assert.equal(settled, false);
      assert.deepEqual(signals, []);
      t.mock.timers.tick(1);
    }
    await checked;
    assert.equal(children.length, ("login" in row && row.name !== "cached login never prompts" && !("preflightUnknown" in row)) ? 2 : 1);
    for (const { child, closed } of children) {
      assert.equal(child.stdin.writableEnded, child === children[0]!.child);
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

test("real ordinary child cached login needs neither input nor PTY", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agy-auth-"));
  const executable = join(directory, "agy");
  const record = join(directory, "record.json");
  const spawn = cp.spawn;
  const commands: string[] = [];
  t.after(async () => {
    mock.restoreAll();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), input, noTTY: !process.stdin.isTTY && !process.stdout.isTTY && !process.stderr.isTTY }));
  process.stdout.write('Quota:\\nGemini Models  Weekly Limit Remaining 97%\\n');
}, 25);
`, { mode: 0o755 });
  mock.method(cp, "spawn", (...args: Parameters<typeof cp.spawn>) => {
    commands.push(args[0]);
    assert.equal(args[0], executable, "cached login must not launch script");
    return spawn(...args);
  });
  syncBuiltinESMExports();

  await loginAgyAuthentication({
    signal: new AbortController().signal,
    notify() { assert.fail("cached login must not notify"); },
    prompt() { assert.fail("cached login must not prompt"); },
  }, executable);

  assert.deepEqual(commands, [executable]);
  assert.deepEqual(JSON.parse(await readFile(record, "utf8")), {
    args: ["--print", "/usage"],
    input: "",
    noTTY: true,
  });
});
