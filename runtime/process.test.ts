import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe, it } from "node:test";
import { AgyProcess } from "./process.ts";
import { AgyProcessError } from "../shared/types.ts";

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

  it("sends multiple stream-json inputs through one process and exposes events", async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-process-reuse-"));
    t.after(() => rm(tempDir, { recursive: true, force: true }));
    const executable = path.join(tempDir, "agy");
    const script = `#!${process.execPath}
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ event: "init" }) + "\\n");
lines.on("line", (line) => {
  const input = JSON.parse(line);
  process.stdout.write(JSON.stringify({ event: "step_update", text_delta: input.message.content }) + "\\n");
  process.stdout.write(JSON.stringify({ event: "result", status: "success" }) + "\\n");
});
`;
    await writeFile(executable, script, "utf-8");
    await chmod(executable, 0o755);

    const proc = new AgyProcess({ agyPath: executable, agentName: "pi-test", model: "test" });
    t.after(() => proc.abort());

    await proc.start();
    const events = proc.events()[Symbol.asyncIterator]();
    for (const prompt of ["first", "second"]) {
      await proc.send({ event: "user", message: { content: prompt } });
      const received: string[] = [];
      while (true) {
        const { value, done } = await events.next();
        assert.equal(done, false);
        if (value?.event === "step_update" && typeof value.text_delta === "string") {
          received.push(value.text_delta);
        }
        if (value?.event === "result") break;
      }
      assert.deepEqual(received, [prompt]);
    }
    await events.return?.();
  });

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

for (const row of [
  { name: "decodes split UTF-8 and flushes a final result after exit", result: true, trailing: false },
  { name: "keeps a final result settled through trailing events", result: true, trailing: true },
  { name: "reports exit without a final result after draining stdout", result: false, trailing: false },
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
    child.emit("exit", 0, null);
    const payload = Buffer.from('{"event":"step_update","text_delta":"中文😀"}\n');
    for (const byte of payload) child.stdout!.emit("data", Buffer.from([byte]));
    if (row.result) child.stdout!.emit("data", Buffer.from('{"event":"result","status":"success"}'));
    if (row.trailing) child.stdout!.emit("data", Buffer.from('\n{"event":"step_update","text_delta":"trailing"}\n'));
    child.stdout!.emit("end");
    child.emit("close", 0, null);

    assert.equal((await first).value?.text_delta, "中文😀");
    const result = await iterator.next();
    assert.equal(result.value?.event, "result");
    assert.equal(result.value?.status, row.result ? "success" : "error");
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
  { name: "spawn failure", script: null, message: /Failed to spawn/ },
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
process.stdin.resume();
`, { mode: 0o755 });
      await proc.start();
    } else if (state === "spawn failure") {
      await assert.rejects(proc.start(), AgyProcessError);
    }
    if (state === "exited") await proc.abort();
    const iterator = proc.events()[Symbol.asyncIterator]();
    const pending = iterator.next();

    await proc.abort();

    assert.deepEqual(await pending, { value: undefined, done: true });
    assert.equal(proc.isRunning, false);
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  });
}
