import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe, it } from "node:test";
import { AgyProcess, type AgyEventSource } from "./process.ts";
import { AgyProcessError, type AgyEvent } from "../shared/types.ts";

describe("AgyProcess", () => {
  it("starts agy with stream-json input and output", async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-process-test-"));
    t.after(() => rm(tempDir, { recursive: true, force: true }));
    const executable = path.join(tempDir, "agy");
    const argsFile = path.join(tempDir, "args.json");
    const script = `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ event: "init" }) + "\\n");
process.stdin.resume();
`;

    await writeFile(executable, script, "utf-8");
    await chmod(executable, 0o755);

    const proc = new AgyProcess({
      agyPath: executable,
      agentName: "pi-test",
      model: "gemini-3.8-flash-high",
    });

    t.after(() => proc.abort());

    await proc.start();
    const args = JSON.parse(await readFile(argsFile, "utf-8")) as string[];

    assert.equal(args.some((arg) => arg.startsWith("--print")), false);
    assert.deepEqual(args.slice(args.indexOf("--input-format"), args.indexOf("--input-format") + 4), [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
    ]);
  });

  for (const model of ["claude-sonnet-4-6", "claude-opus-4-6-thinking"]) {
    it(`preserves ${model} without an effort argument`, async (t) => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-thinking-model-"));
      t.after(() => rm(tempDir, { recursive: true, force: true }));
      const executable = path.join(tempDir, "agy");
      const argsFile = path.join(tempDir, "args.json");
      await writeFile(executable, `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ event: "init" }) + "\\n");
process.stdin.resume();
`, { mode: 0o755 });
      const proc = new AgyProcess({ agyPath: executable, agentName: "pi-test", model });
      t.after(() => proc.abort());

      await proc.start();
      const args = JSON.parse(await readFile(argsFile, "utf-8")) as string[];

      assert.equal(args[args.indexOf("--model") + 1], model);
      assert.equal(args.includes("--effort"), false);
    });
  }

  for (const row of [
    { name: "sends multiple stream-json inputs through one process and exposes events", exitsOnSecond: false },
    { name: "reports exactly one runtime failure when turn two exits without a result after turn one succeeds", exitsOnSecond: true },
  ]) {
    it(row.name, { timeout: 5000 }, async (t) => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-process-reuse-"));
      t.after(() => rm(tempDir, { recursive: true, force: true }));
      const executable = path.join(tempDir, "agy");
      const inputsFile = path.join(tempDir, "inputs.json");
      const script = `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
const inputs = [];
process.stdout.write(JSON.stringify({ event: "init" }) + "\\n");
lines.on("line", (line) => {
  const input = JSON.parse(line);
  inputs.push(input);
  writeFileSync(${JSON.stringify(inputsFile)}, JSON.stringify(inputs));
  if (inputs.length === 2 && ${row.exitsOnSecond}) process.exit(0);
  process.stdout.write(JSON.stringify({ event: "step_update", text_delta: input.message.content }) + "\\n");
  process.stdout.write(JSON.stringify({ event: "result", status: "success" }) + "\\n");
});
`;
      await writeFile(executable, script, "utf-8");
      await chmod(executable, 0o755);

      const proc = new AgyProcess({ agyPath: executable, agentName: "pi-test", model: "test" });
      t.after(() => proc.abort());

      await proc.start();
      const received: { event: AgyEvent; source: AgyEventSource }[] = [];
      proc.onEvent((event, source) => received.push({ event, source }));
      const events = proc.events()[Symbol.asyncIterator]();
      const inputs = ["first", "second"].map((content) => ({ event: "user", message: { content } } as const));
      for (const input of inputs) {
        const start = received.length;
        const turnEvents: AgyEvent[] = [];
        let pending = events.next();

        await proc.send(input);
        while (true) {
          const { value, done } = await pending;
          assert.equal(done, false);
          assert.ok(value);
          turnEvents.push(value);
          if (value.event === "result") break;
          pending = events.next();
        }

        const failed = row.exitsOnSecond && input.message.content === "second";
        const expected: AgyEvent[] = failed
          ? [{ event: "result", status: "error", error: { message: "Antigravity CLI process terminated unexpectedly (exit code 0, signal none)" } }]
          : [{ event: "step_update", text_delta: input.message.content }, { event: "result", status: "success" }];
        assert.equal(turnEvents.length, expected.length);
        assert.deepEqual(turnEvents, expected);
        assert.deepEqual(received.slice(start), expected.map((event) => ({ event, source: failed ? "runtime" : "agy" })));
      }
      assert.deepEqual(JSON.parse(await readFile(inputsFile, "utf-8")), inputs);
      if (row.exitsOnSecond) {
        assert.deepEqual(await events.next(), { value: undefined, done: true });
        assert.equal(proc.isRunning, false);
      }
      await events.return?.();
    });
  }

  it("send() throws when process is not running", async () => {
    const proc = new AgyProcess({
      agentName: "pi-test",
      model: "gemini-3.8-flash-high",
    });

    await assert.rejects(
      async () => proc.send({ event: "user", message: { content: "Hello" } }),
      (err: any) => {
        assert.equal(err instanceof AgyProcessError, true);
        return true;
      }
    );
  });

  it("caps captured stderr from the child process", async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-process-stderr-"));
    t.after(() => rm(tempDir, { recursive: true, force: true }));
    const executable = path.join(tempDir, "agy");
    const script = `#!${process.execPath}
process.stderr.write("X".repeat(40000));
process.exit(1);
`;
    await writeFile(executable, script, "utf-8");
    await chmod(executable, 0o755);

    const proc = new AgyProcess({ agyPath: executable, agentName: "pi-test", model: "test" });
    t.after(() => proc.abort());

    await assert.rejects(proc.start(), (error: unknown) => {
      assert.ok(error instanceof AgyProcessError);
      assert.equal(error.stderr?.length, 32768);
      return true;
    });
  });

  it("passes environment variables when environment option is provided", async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-process-env-"));
    t.after(() => rm(tempDir, { recursive: true, force: true }));
    const executable = path.join(tempDir, "agy");
    const recordedFile = path.join(tempDir, "recorded.json");
    const script = `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(recordedFile)}, JSON.stringify({
  args: process.argv.slice(2),
  mcpCommand: process.env.PI_AGY_BRIDGE_MCP_COMMAND,
}));
process.stdout.write(JSON.stringify({ event: "init" }) + "\\n");
process.stdin.resume();
`;

    await writeFile(executable, script, "utf-8");
    await chmod(executable, 0o755);

    const proc = new AgyProcess({
      agyPath: executable,
      agentName: "pi-test",
      model: "gemini-3.8-flash-high",
      conversationId: "conversation-1",
      environment: {
        PI_AGY_BRIDGE_MCP_COMMAND: "node mcp-server.js --endpoint unix:///tmp/pi-agy.sock?session=session-1",
      },
    });

    t.after(() => proc.abort());

    await proc.start();
    const recorded = JSON.parse(await readFile(recordedFile, "utf-8")) as {
      args: string[];
      mcpCommand?: string;
    };
    assert.deepEqual(recorded.args.slice(recorded.args.indexOf("--conversation"), recorded.args.indexOf("--conversation") + 2), [
      "--conversation",
      "conversation-1",
    ]);
    assert.equal(recorded.mcpCommand, "node mcp-server.js --endpoint unix:///tmp/pi-agy.sock?session=session-1");
  });
});

const quotaError = "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h27m34s.";
const exitQuotaError = `Antigravity CLI process terminated unexpectedly (exit code 1, signal none): ${quotaError}`;
const processQuotaError = `Antigravity CLI process error: ${quotaError}`;
const stdinQuotaError = `Antigravity CLI stdin error: ${quotaError}`;

for (const row of [
  { name: "native quota error", failure: "native", message: quotaError },
  { name: "native error identical to synthetic exit", failure: "native", message: exitQuotaError },
  { name: "synthetic exit with quota stderr", failure: "exit", message: exitQuotaError },
  { name: "native error identical to synthetic process failure", failure: "native", message: processQuotaError },
  { name: "synthetic process failure with quota text", failure: "process", message: processQuotaError },
  { name: "native error identical to synthetic stdin failure", failure: "native", message: stdinQuotaError },
  { name: "synthetic stdin failure with quota text", failure: "stdin", message: stdinQuotaError },
] as const) {
  test(`classifies provenance independently of payload: ${row.name}`, { timeout: 5000 }, async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-process-source-"));
    t.after(() => rm(tempDir, { recursive: true, force: true }));
    const executable = path.join(tempDir, "agy");
    await writeFile(executable, `#!${process.execPath}
process.stdout.write('{"event":"init"}\\n');
process.stdin.resume();
`, { mode: 0o755 });
    const proc = new AgyProcess({ agyPath: executable, agentName: "test", model: "test" });
    let child: ChildProcess | null = null;
    t.after(async () => {
      child?.kill("SIGKILL");
      await proc.abort();
    });
    await proc.start();
    child = (proc as unknown as { child: ChildProcess }).child;
    const received: { event: AgyEvent; source: AgyEventSource }[] = [];
    proc.onEvent((event, source) => received.push({ event, source }));
    const iterator = proc.events()[Symbol.asyncIterator]();
    const pending = iterator.next();
    const expected: AgyEvent = { event: "result", status: "error", error: { message: row.message } };
    if (row.failure === "native") expected.source = "runtime";
    const input = { event: "user", message: { content: "test" } } as const;
    const write = t.mock.method(child.stdin!, "write");

    await proc.send(input);
    assert.equal(write.mock.calls[0]?.arguments[0], `${JSON.stringify(input)}\n`);
    if (row.failure === "native") {
      child.stdout!.emit("data", Buffer.from(`${JSON.stringify(expected)}\n`));
      child.stdout!.emit("end");
      child.emit("close", 1, null);
    } else if (row.failure === "exit") {
      child.stderr!.emit("data", Buffer.from(quotaError));
      child.stdout!.emit("end");
      child.emit("close", 1, null);
    } else if (row.failure === "process") {
      child.emit("error", new Error(quotaError));
    } else {
      child.stdin!.emit("error", new Error(quotaError));
    }

    assert.deepEqual(await pending, { value: expected, done: false });
    assert.equal((await iterator.next()).done, true);
    assert.deepEqual(received, [{ event: expected, source: row.failure === "native" ? "agy" : "runtime" }]);
  });
}

for (const row of [
  { name: "decodes split UTF-8 and flushes a final success after exit", status: "success", trailing: false },
  { name: "flushes a native error after exit without a synthetic result", status: "error", trailing: false },
  { name: "keeps a final success settled through trailing events", status: "success", trailing: true },
  { name: "keeps a final native error settled through trailing events", status: "error", trailing: true },
  { name: "reports exit without a final result after draining stdout", status: null, trailing: false },
]) {
  test(row.name, async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-process-drain-"));
    t.after(() => rm(tempDir, { recursive: true, force: true }));
    const executable = path.join(tempDir, "agy");
    await writeFile(executable, `#!${process.execPath}
process.stdout.write('{"event":"init"}\\n');
process.stdin.resume();
`, { mode: 0o755 });
    const proc = new AgyProcess({ agyPath: executable, agentName: "test", model: "test" });
    let child: ChildProcess | null = null;
    t.after(async () => {
      child?.kill("SIGKILL");
      await proc.abort();
    });

    await proc.start();
    child = (proc as unknown as { child: ChildProcess }).child;
    const iterator = proc.events()[Symbol.asyncIterator]();
    const first = iterator.next();
    const results: { event: AgyEvent; source: AgyEventSource }[] = [];
    proc.onEvent((event, source) => {
      if (event.event === "result") results.push({ event, source });
    });
    child.emit("exit", 0, null);
    const payload = Buffer.from('{"event":"step_update","text_delta":"中文😀"}\n');
    for (const byte of payload) child.stdout!.emit("data", Buffer.from([byte]));
    const nativeResult = { event: "result", status: row.status };
    if (row.status) child.stdout!.emit("data", Buffer.from(JSON.stringify(nativeResult)));
    if (row.trailing) child.stdout!.emit("data", Buffer.from('\n{"event":"step_update","text_delta":"trailing"}\n'));
    child.stdout!.emit("end");
    child.emit("close", 0, null);

    assert.equal((await first).value?.text_delta, "中文😀");
    const result = await iterator.next();
    assert.equal(result.value?.event, "result");
    assert.equal(result.value?.status, row.status ?? "error");
    assert.deepEqual(results, [{ event: result.value, source: row.status ? "agy" : "runtime" }]);
    if (row.status) assert.deepEqual(result.value, nativeResult);
    else assert.equal(Object.hasOwn(result.value!, "source"), false);
    if (row.trailing) assert.equal((await iterator.next()).value?.text_delta, "trailing");
    assert.equal((await iterator.next()).done, true);
  });
}

for (const row of [
  { name: "abort escalates when SIGINT is ignored", nodeExit: false },
  { name: "node exit kills a child already sent SIGINT", nodeExit: true },
]) {
  test(row.name, async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-process-kill-"));
    t.after(() => rm(tempDir, { recursive: true, force: true }));
    const executable = path.join(tempDir, "agy");
    await writeFile(executable, `#!${process.execPath}
process.on("SIGINT", () => {});
process.stdout.write('{"event":"init"}\\n');
process.stdin.resume();
`, { mode: 0o755 });
    const before = new Set(process.listeners("exit"));
    const proc = new AgyProcess({ agyPath: executable, agentName: "test", model: "test" });
    let child: ChildProcess | null = null;
    t.after(async () => {
      child?.kill("SIGKILL");
      await proc.abort();
    });

    await proc.start();
    child = (proc as unknown as { child: ChildProcess }).child;
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));

    if (row.nodeExit) {
      child.kill("SIGINT");
      assert.equal(child.killed, true);
      const listener = process.listeners("exit").find((candidate) => !before.has(candidate));
      assert.ok(listener);
      listener(0);
    } else {
      await proc.abort();
    }

    assert.equal(await exited, "SIGKILL");
    await proc.abort();
    assert.equal(proc.isRunning, false);
  });
}

for (const row of [
  { name: "exit before init", script: 'process.stderr.write("init failed"); process.exit(1);', message: /exited prematurely/ },
  { name: "spawn failure", script: null, message: /Failed to start Antigravity CLI/ },
]) {
  test(`rejects ${row.name}`, async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-process-init-"));
    t.after(() => rm(tempDir, { recursive: true, force: true }));
    const executable = path.join(tempDir, "agy");
    const proc = new AgyProcess({ agyPath: executable, agentName: "test", model: "test" });
    t.after(() => proc.abort());
    if (row.script !== null) await writeFile(executable, `#!${process.execPath}\n${row.script}\n`, { mode: 0o755 });

    await assert.rejects(proc.start(), (error: unknown) => {
      assert.ok(error instanceof AgyProcessError);
      assert.match(error.message, row.message);
      if (row.script !== null) assert.equal(error.stderr, "init failed");
      return true;
    });
    assert.equal(proc.isRunning, false);
  });
}

for (const state of ["unstarted", "active", "exited", "spawn failure"] as const) {
  test(`abort ends a pending iterator: ${state}`, { timeout: 5000 }, async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-process-abort-"));
    t.after(() => rm(tempDir, { recursive: true, force: true }));
    const executable = path.join(tempDir, "agy");
    const proc = new AgyProcess({ agyPath: executable, agentName: "test", model: "test" });
    t.after(() => proc.abort());
    if (state === "active" || state === "exited") {
      await writeFile(executable, `#!${process.execPath}
process.stdout.write('{"event":"init"}\\n');
${state === "exited" ? `process.stdin.once("data", () => {
  process.stdout.write('{"event":"result","status":"success"}\\n', () => process.exit(0));
});` : "process.stdin.resume();"}
`, { mode: 0o755 });
      await proc.start();
    } else if (state === "spawn failure") {
      await assert.rejects(proc.start(), AgyProcessError);
    }
    if (state === "exited") {
      const child = (proc as unknown as { child: ChildProcess }).child;
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

      await proc.send({ event: "user", message: { content: "finish naturally" } });
      await closed;

      assert.equal(child.exitCode, 0);
      assert.equal(child.signalCode, null);
      assert.equal(child.killed, false);
      assert.equal(proc.isRunning, false);
    }
    const iterator = proc.events()[Symbol.asyncIterator]();
    const pending = iterator.next();

    await proc.abort();

    assert.deepEqual(await pending, { value: undefined, done: true });
    assert.equal(proc.isRunning, false);
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  });
}

for (const row of [
  { name: "before init", phase: "starting", failure: "event", result: false },
  { name: "during a turn", phase: "started", failure: "event", result: false },
  { name: "write callback failure without an emitted error", phase: "started", failure: "callback-only", result: false },
  { name: "write callback then emitted error", phase: "started", failure: "callback", result: false },
  { name: "asynchronous writable destruction", phase: "started", failure: "destroy", result: false },
  { name: "synchronous write failure", phase: "started", failure: "throw", result: false },
  { name: "after a completed turn", phase: "started", failure: "event", result: true },
  { name: "after abort", phase: "aborted", failure: "event", result: false },
] as const) {
  test(`handles stdin failure ${row.name}`, { timeout: 5000 }, async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-process-stdin-"));
    t.after(() => rm(tempDir, { recursive: true, force: true }));
    const executable = path.join(tempDir, "agy");
    await writeFile(executable, `#!${process.execPath}
${row.phase === "starting" ? "" : "process.stdout.write('{\"event\":\"init\"}\\n');"}
process.stdin.resume();
`, { mode: 0o755 });
    const before = process.listeners("exit");
    const proc = new AgyProcess({ agyPath: executable, agentName: "test", model: "test" });
    t.after(() => proc.abort());
    const starting = proc.start();
    const child = (proc as unknown as { child: ChildProcess }).child;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const rejection = row.phase === "starting"
      ? assert.rejects(starting, (error: unknown) => {
          assert.ok(error instanceof AgyProcessError);
          assert.match(error.message, /stdin error: broken pipe/);
          return true;
        })
      : null;
    if (row.phase !== "starting") await starting;
    if (row.phase === "aborted") await proc.abort();
    if (row.result) child.stdout!.emit("data", Buffer.from('{"event":"result","status":"success"}\n'));
    const iterator = proc.events()[Symbol.asyncIterator]();
    const pending = iterator.next();
    const results: { event: AgyEvent; source: AgyEventSource }[] = [];
    proc.onEvent((event, source) => {
      if (event.event === "result") results.push({ event, source });
    });
    const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });

    if (row.failure === "destroy") {
      child.stdin!.destroy(error);
      await new Promise<void>((resolve) => child.stdin!.once("close", resolve));
    } else if (row.failure !== "event") {
      t.mock.method(child.stdin!, "write", (_payload: unknown, _encoding: unknown, callback: (error: Error) => void) => {
        if (row.failure === "throw") throw error;
        callback(error);
        if (row.failure === "callback") child.stdin!.emit("error", error);
        return false;
      });
      await assert.rejects(proc.send({ event: "user", message: { content: "test" } }), (failure: unknown) => {
        assert.ok(failure instanceof AgyProcessError);
        assert.match(failure.message, /Failed to write turn to stdin: broken pipe/);
        return true;
      });
    } else {
      assert.doesNotThrow(() => child.stdin!.emit("error", error));
    }
    assert.equal(proc.isRunning, false);
    // A second error during shutdown must stay handled without another result.
    assert.doesNotThrow(() => child.stdin!.emit("error", error));
    await rejection;
    await closed;

    const received = await pending;
    if (row.phase === "started" && !row.result) {
      assert.equal(received.value?.event, "result");
      assert.equal(received.value?.status, "error");
      assert.deepEqual(received.value, {
        event: "result", status: "error", error: { message: "Antigravity CLI stdin error: broken pipe" },
      });
      assert.deepEqual(results, [{ event: received.value, source: "runtime" }]);
      assert.equal((await iterator.next()).done, true);
    } else {
      assert.equal(received.done, true);
      assert.deepEqual(results, []);
    }
    assert.equal(proc.isRunning, false);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.deepEqual(process.listeners("exit"), before);
    await assert.rejects(proc.send({ event: "user", message: { content: "later" } }), AgyProcessError);
  });
}

for (const row of [
  { name: "terminates a live child that never initializes", init: false, ignoreInterrupt: false },
  { name: "escalates termination when a non-initializing child ignores SIGINT", init: false, ignoreInterrupt: true },
  { name: "clears the timeout after successful initialization", init: true, ignoreInterrupt: false },
] as const) {
  test(row.name, { timeout: 5000 }, async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-process-timeout-"));
    t.after(() => rm(tempDir, { recursive: true, force: true }));
    const executable = path.join(tempDir, "agy");
    await writeFile(executable, `#!${process.execPath}
${row.ignoreInterrupt ? 'process.on("SIGINT", () => {});' : ""}
process.stderr.write("waiting for initialization");
${row.init ? "process.stdout.write('{\"event\":\"init\"}\\n');" : ""}
process.stdin.resume();
`, { mode: 0o755 });
    const before = process.listeners("exit");
    const proc = new AgyProcess({ agyPath: executable, agentName: "test", model: "test", initTimeoutMs: 500 });
    t.after(() => proc.abort());
    const starting = proc.start();
    const child = (proc as unknown as { child: ChildProcess }).child;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

    if (row.init) {
      assert.equal((await starting).event, "init");
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.equal(proc.isRunning, true);
      await proc.abort();
    } else {
      await new Promise<void>((resolve) => child.stderr!.once("data", () => resolve()));
      assert.equal(proc.isRunning, true);
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);

      await assert.rejects(starting, (error: unknown) => {
        assert.ok(error instanceof AgyProcessError);
        assert.match(error.message, /Timed out waiting for Antigravity CLI init event after 500ms: waiting for initialization/);
        assert.equal(error.stderr, "waiting for initialization");
        return true;
      });
    }
    await closed;

    if (!row.init) assert.equal(child.signalCode, row.ignoreInterrupt ? "SIGKILL" : "SIGINT");
    assert.equal(proc.isRunning, false);
    assert.deepEqual(process.listeners("exit"), before);
    assert.equal((await proc.events()[Symbol.asyncIterator]().next()).done, true);
  });
}
