import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { Connection } from "./connection.ts";

const execFileAsync = promisify(execFile);
const fixture = fileURLToPath(new URL("./connection-fixture.ts", import.meta.url));
function create(mode = "normal", extra: Partial<ConstructorParameters<typeof Connection>[0]> = {}) {
  return new Connection({ executable: process.execPath, cwd: process.cwd(),
    args: ["--experimental-strip-types", fixture, mode], requestTimeoutMs: 2000, ...extra });
}
const prompt = { sessionId: "synthetic", prompt: [{ type: "text" as const, text: "synthetic" }] };

function onlyPermissionErrors(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(onlyPermissionErrors);
  return error instanceof Error && "code" in error && error.code === "EPERM";
}

test("large stderr does not block SDK handshake, requests, notifications or lifecycle", async () => {
  const updates: acp.SessionNotification[] = [];
  let notified!: () => void;
  const notification = new Promise<void>((resolve) => { notified = resolve; });
  const connection = create("normal", {
    args: ["--experimental-strip-types", "--input-type=module", "-e", `
      await new Promise((resolve, reject) => {
        process.stderr.write("x".repeat(8 * 1024 * 1024), (error) => error ? reject(error) : resolve());
      });
      await import(${JSON.stringify(new URL("./connection-fixture.ts", import.meta.url).href)});
    `, fixture, "normal"],
    onUpdate: (update) => {
      updates.push(update);
      if (update.update.sessionUpdate === "agent_message_chunk" && update.update.content.type === "text" && update.update.content.text === "cancel") notified();
    },
  });
  const exitListeners = process.listenerCount("exit");
  try {
    assert.equal((await connection.start()).protocolVersion, acp.PROTOCOL_VERSION);
    assert.equal(process.listenerCount("exit"), exitListeners + 1);
    for (let i = 0; i < 2; i++) {
      assert.equal((await connection.request(acp.methods.agent.session.prompt, prompt)).stopReason, "end_turn");
      assert.equal(connection.isRunning, true);
    }
    assert.equal(updates.length, 2);
    assert.deepEqual(updates[0]?.update, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "cancelled" } });
    await connection.notify(acp.methods.agent.session.cancel, { sessionId: "synthetic" });
    await notification;
    assert.equal(updates.length, 3);
    const disposing = connection.dispose();
    assert.equal(process.listenerCount("exit"), exitListeners + 1);
    await disposing;
  } finally { await connection.dispose(); }
  assert.equal(connection.isRunning, false);
  assert.equal(process.listenerCount("exit"), exitListeners);
  await connection.dispose();
  assert.equal(process.listenerCount("exit"), exitListeners);
});

for (const row of [
  { name: "early exit", mode: "exit", phase: "start", error: /closed/ },
  { name: "failed spawn", mode: "normal", phase: "start", error: /ENOENT/, executable: "/nonexistent/acp-fixture" },
  { name: "startup timeout", mode: "startup-hang", phase: "start", error: /timeout/ },
  { name: "request timeout", mode: "blocked-stdin", phase: "ordinary-request", error: /timeout: session\/new/ },
  { name: "process close during request", mode: "prompt-exit", phase: "request", error: /closed/ },
  { name: "startup cancellation", mode: "startup-hang", phase: "abort", error: /synthetic cancellation/ },
  { name: "dispose during startup", mode: "startup-hang", phase: "dispose", error: /disposed/ },
]) {
  test(row.name, async () => {
    const connection = create(row.mode, { requestTimeoutMs: 500, ...(row.executable ? { executable: row.executable } : {}) });
    const controller = new AbortController();
    try {
      const starting = connection.start(controller.signal);
      const rejected = row.phase === "ordinary-request"
        ? starting.then(() => connection.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] }))
        : row.phase === "request"
          ? starting.then(() => connection.request(acp.methods.agent.session.prompt, prompt)) : starting;
      const assertion = assert.rejects(rejected, row.error);
      if (row.phase === "abort") controller.abort(new Error("synthetic cancellation"));
      if (row.phase === "dispose") await connection.dispose();
      await assertion;
      assert.equal(connection.isRunning, false);
    } finally {
      try {
        await connection.dispose();
      } catch (error) {
        // The Darwin harness can deny signalling an already-exited group. The
        // connection must report that cleanup failure, not silently claim success.
        assert.equal(process.platform, "darwin");
        assert.ok(row.mode === "exit" || row.mode === "prompt-exit");
        assert.ok(onlyPermissionErrors(error));
      }
    }
  });
}

for (const outcome of ["complete", "cancel", "dispose"] as const) {
  test(`prompt survives request deadline before ${outcome}`, async () => {
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    let release!: (response: acp.RequestPermissionResponse) => void;
    const permission = new Promise<acp.RequestPermissionResponse>((resolve) => { release = resolve; });
    const connection = create("normal", { requestTimeoutMs: 500, onPermission: () => {
      entered();
      return permission;
    } });
    const exitListeners = process.listenerCount("exit");
    try {
      await connection.start();
      let settled = false;
      const pending = connection.request(acp.methods.agent.session.prompt, prompt);
      void pending.then(() => { settled = true; }, () => { settled = true; });
      await waiting;
      await new Promise((resolve) => setTimeout(resolve, 750));
      assert.equal(settled, false);
      assert.equal(connection.isRunning, true);

      if (outcome === "complete") {
        release({ outcome: { outcome: "cancelled" } });
        assert.equal((await pending).stopReason, "end_turn");
        assert.equal(connection.isRunning, true);
      } else {
        const rejected = assert.rejects(pending, /disposed/);
        if (outcome === "cancel") {
          await connection.notify(acp.methods.agent.session.cancel, { sessionId: prompt.sessionId });
        }
        await connection.dispose();
        await rejected;
        assert.equal(connection.isRunning, false);
      }
    } finally {
      release({ outcome: { outcome: "cancelled" } });
      await connection.dispose();
    }
    assert.equal(process.listenerCount("exit"), exitListeners);
  });
}

test("pre-aborted startup does not spawn and permission callback is used", async () => {
  const aborted = create();
  await assert.rejects(aborted.start(AbortSignal.abort(new Error("pre-aborted"))), /pre-aborted/);
  assert.equal(aborted.isRunning, false);
  await aborted.dispose();

  let called = false;
  const connection = create("normal", { onPermission: () => { called = true; return { outcome: { outcome: "cancelled" } }; } });
  try {
    await connection.start();
    await connection.request(acp.methods.agent.session.prompt, prompt);
    assert.equal(called, true);
  } finally { await connection.dispose(); }
});

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    // Linux containers may retain orphan zombies until their init reaps them.
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
    }
    return true;
  } catch (error) {
    if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

for (const mode of ["running", "stopping", "leader-exited"]) {
  test(`host exit cleans ACP and TERM-resistant descendant: ${mode}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-host-exit-"));
    const childPidFile = join(dir, "child-pid");
    const agentPidFile = join(dir, "agent-pid");
    try {
      const { stderr } = await execFileAsync(process.execPath, [
        "--experimental-strip-types", fileURLToPath(new URL("./host-exit-fixture.ts", import.meta.url)),
        mode, childPidFile, agentPidFile,
      ], { timeout: 5000 });
      assert.doesNotMatch(stderr, /ACP host-exit cleanup failed/);

      for (const pidFile of [agentPidFile, childPidFile]) {
        const pid = Number(await readFile(pidFile, "utf8"));
        assert.ok(Number.isInteger(pid) && pid > 1);
        for (let attempt = 0; attempt < 100 && await alive(pid); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(await alive(pid), false, `process ${pid} survived host exit (${mode})`);
      }
    } finally {
      try {
        // Clean synthetic processes even when the regression assertion fails.
        for (const pidFile of [childPidFile, agentPidFile]) {
          try {
            const pid = Number(await readFile(pidFile, "utf8"));
            if (Number.isInteger(pid) && pid > 1 && await alive(pid)) process.kill(pid, "SIGKILL");
          } catch (error) {
            if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          }
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
}

for (const mode of ["descendant", "descendant-exit"]) {
  test(`owned group cleans TERM-resistant child: ${mode}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-child-"));
    const pidFile = join(dir, "pid");
    const connection = create(mode, { args: ["--experimental-strip-types", fixture, mode, pidFile] });
    let pid: number | undefined;
    try {
      await connection.start();
      for (let i = 0; i < 100; i++) {
        try { pid = Number(await readFile(pidFile, "utf8")); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(pid);
      assert.equal(await alive(pid), true);
      if (mode === "descendant-exit") {
        await assert.rejects(connection.request(acp.methods.agent.session.prompt, prompt), /closed/);
      }
      await connection.dispose();
      for (let i = 0; i < 100 && await alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(await alive(pid), false);
      await connection.dispose();
    } finally {
      await connection.dispose();
      // Also clean up when the assertion fails against a broken implementation.
      if (pid && await alive(pid)) process.kill(pid, "SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("TERM failure is reported only after KILL escalation", async (t) => {
  const connection = create();
  t.after(async () => {
    try { await connection.dispose(); }
    catch (error) { assert.ok(error instanceof AggregateError); }
  });
  await connection.start();
  const kill = process.kill.bind(process);
  const signals: (string | number | undefined)[] = [];
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (pid < 0) {
      signals.push(signal);
      if (signal === "SIGTERM") throw Object.assign(new Error("synthetic signal denial"), { code: "EACCES" });
    }
    return kill(pid, signal);
  });

  await assert.rejects(connection.dispose(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    const nested = error.errors[0];
    assert.ok(nested instanceof AggregateError);
    assert.equal(nested.errors[0].code, "EACCES");
    return true;
  });
  assert.equal(connection.isRunning, false);
});

test("dispose has a deadline when the OS does not close the process", async (t) => {
  const connection = create("blocked-stdin");
  const kill = process.kill.bind(process);
  let group: number | undefined;
  try {
    await connection.start();
    t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
      if (pid < 0) {
        group = pid;
        return true;
      }
      return kill(pid, signal);
    });

    await assert.rejects(connection.dispose(), /did not close within the cleanup deadline/);
    assert.equal(connection.isRunning, false);
  } finally {
    if (group !== undefined) {
      try { kill(group, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    } else {
      await connection.dispose();
    }
  }
});

test("blocked notification writes time out and permit disposal", async () => {
  const connection = create("blocked-stdin", { requestTimeoutMs: 500 });
  try {
    await connection.start();
    await assert.rejects(connection.notify(acp.methods.agent.session.cancel, { sessionId: "x".repeat(8 * 1024 * 1024) }), /timeout/);
    assert.equal(connection.isRunning, false);
  } finally { await connection.dispose(); }
});

for (const mode of ["absent", "read", "shutdown"] as const) {
  test(`client read capability and callback: ${mode}`, async () => {
    const request = { sessionId: "synthetic", path: "/synthetic/artifact", line: 2, limit: 3 };
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    let readSignal: AbortSignal | undefined;
    const calls: acp.ReadTextFileRequest[] = [];
    const reports: Array<{ capabilities: unknown; result: { code?: number; message?: string; content?: string } }> = [];
    const connection = create("normal", {
      args: ["--experimental-strip-types", "--input-type=module", "-e", `
        import { Readable, Writable } from 'node:stream';
        import * as acp from '@agentclientprotocol/sdk';
        let wire = '';
        const { Transform } = await import('node:stream');
        const input = new Transform({ transform(chunk, encoding, callback) {
          wire += chunk.toString();
          callback(null, chunk);
        } });
        process.stdin.pipe(input);
        let capabilities;
        const connection = acp.agent()
          .onRequest(acp.methods.agent.initialize, () => {
            capabilities = wire.split('\\n').filter(Boolean).map(line => JSON.parse(line))
              .find(message => message.method === 'initialize').params.clientCapabilities;
            return { protocolVersion: acp.PROTOCOL_VERSION };
          })
          .onRequest(acp.methods.agent.session.prompt, async ({ client }) => {
            let result;
            try { result = await client.request(acp.methods.client.fs.readTextFile, ${JSON.stringify(request)}); }
            catch (error) { result = { code: error.code, message: error.message }; }
            await client.notify(acp.methods.client.session.update, {
              sessionId: 'synthetic', update: { sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: JSON.stringify({ capabilities, result }) } }
            });
            return { stopReason: 'end_turn' };
          })
          .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(input)));
        await connection.closed;
      `],
      ...(mode === "absent" ? {} : { onRead: async (params: acp.ReadTextFileRequest, signal: AbortSignal) => {
        calls.push(params);
        readSignal = signal;
        entered();
        if (mode === "shutdown") await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { content: "bounded page" };
      } }),
      onUpdate: (notification) => {
        const update = notification.update;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          reports.push(JSON.parse(update.content.text));
        }
      },
    });
    try {
      await connection.start();
      const pending = connection.request(acp.methods.agent.session.prompt, prompt);
      if (mode === "shutdown") {
        const rejected = assert.rejects(pending, /disposed/);
        await reading;
        assert.equal(readSignal?.aborted, false);
        await connection.dispose();
        await rejected;
        assert.equal(readSignal?.aborted, true);
      } else await pending;
      assert.deepEqual(calls, mode === "absent" ? [] : [request]);
      assert.equal(reports.length, mode === "shutdown" ? 0 : 1);
      for (const report of reports) {
        assert.deepEqual(report.capabilities, mode === "absent" ? {} : { fs: { readTextFile: true } });
        if (mode === "absent") {
          assert.equal(report.result.code, -32601);
          assert.match(report.result.message ?? "", /reads are unavailable/);
        } else assert.deepEqual(report.result, { content: "bounded page" });
      }
    } finally { await connection.dispose(); }
  });
}
