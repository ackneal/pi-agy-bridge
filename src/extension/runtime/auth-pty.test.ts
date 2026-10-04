import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import { authenticationPipeBroker, spawnAuthenticationPty } from "./auth-pty.ts";

const originalSpawn = childProcess.spawn;
const originalSpawnSync = childProcess.spawnSync;

const cases = [
  { name: "valid ownership opens gate", frame: "40001 40001\n", valid: true },
  { name: "different process group", frame: "40001 40002\n", valid: false },
  { name: "broker ownership rejected", frame: "40000 40000\n", valid: false },
  { name: "application ownership rejected", frame: "39999 39999\n", valid: false },
  { name: "parent ownership rejected", frame: `${process.pid} ${process.pid}\n`, valid: false },
  { name: "overflow rejected", frame: "2147483648 2147483648\n", valid: false },
  { name: "zero rejected", frame: "0 0\n", valid: false },
  { name: "multiple frames rejected", frame: "40001 40001\n40002 40002\n", valid: false },
  { name: "oversized frame rejected", frame: "1".repeat(128), valid: false },
  { name: "late cancellation never opens gate", frame: "40001 40001\n", valid: true, cancel: true },
];
for (const row of cases) {
  test(row.name, (t) => {
    const streams = Array.from({ length: 5 }, () => new PassThrough());
    const child = Object.assign(new EventEmitter(), { pid: 40000, stdio: streams, stdin: streams[0], stdout: streams[1], stderr: streams[2] });
    const signals: [number, string | number | undefined][] = [];
    const failures: string[] = [];
    let ack = "";
    streams[4]!.on("data", (data: Buffer) => { ack += data.toString(); });
    t.mock.method(childProcess, "spawnSync", () => ({ stdout: "39999\n" }));
    t.mock.method(childProcess, "spawn", (_command: string, _args: string[], options: { detached: boolean; stdio: string[] }) => {
      assert.equal(options.detached, true);
      assert.deepEqual(options.stdio, Array(5).fill("pipe"));
      return child;
    });
    t.mock.method(process, "kill", (pid: number, signal?: string | number) => { signals.push([pid, signal]); return true; });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      childProcess.spawn = originalSpawn;
      childProcess.spawnSync = originalSpawnSync;
      syncBuiltinESMExports();
    });

    const transport = spawnAuthenticationPty("/usr/bin/printf", ["%s", "secret"], (message) => failures.push(message));
    t.after(() => transport.dispose());
    assert.equal(ack, "");
    child.stdout!.emit("data", "40001 40001\n");
    assert.equal(ack, "");
    if (row.cancel) transport.kill("SIGTERM");
    streams[3]!.emit("data", Buffer.from(row.frame));
    assert.equal(ack, row.valid && !row.cancel ? "start\n" : "");
    assert.equal(failures.length, row.valid ? 0 : 1);
    if (row.cancel) assert.ok(signals.some(([pid]) => pid === -40001));
    if (!row.valid) assert.deepEqual(failures, ["Could not start an interactive terminal for Antigravity CLI authentication"]);
    transport.kill("SIGKILL");
    if (row.valid) assert.ok(signals.some(([pid, signal]) => pid === -40001 && signal === "SIGKILL"));
    child.emit("close", 0);
    transport.dispose();
    transport.dispose();
    assert.equal(streams[3]!.listenerCount("data"), 0);
  });
}

for (const status of [0, 23]) {
  test(`real pipe broker exits with consumer status ${status} while stdin stays open`, { timeout: 5000 }, async (t) => {
    const child = originalSpawn("/bin/sh", ["-c", authenticationPipeBroker, "auth-broker", "/bin/sh", "-c", 'printf output; printf error >&2; exec 3>&- 4<&-; exit "$1"', "consumer", String(status)], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => { if (child.pid) process.kill(-child.pid, "SIGKILL"); }, 3000);
    t.after(() => {
      clearTimeout(timer);
      child.stdin?.destroy();
      for (const stream of child.stdio) stream?.destroy();
    });
    let output = "";
    let errors = "";
    child.stdout!.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr!.on("data", (data: Buffer) => { errors += data.toString(); });

    const result = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve([code, signal]));
    });
    assert.deepEqual(result, [status, null], errors);
    assert.equal(child.stdin!.writableEnded, false);
    assert.equal(output, "output");
    assert.match(errors, /error/);
  });
}

test("real system PTY preserves exact arguments or reports sandbox openpty denial", { timeout: 5000 }, async (t) => {
  childProcess.spawn = originalSpawn;
  childProcess.spawnSync = originalSpawnSync;
  syncBuiltinESMExports();
  const value = "spaces 'quotes' \"double\" ; $(echo INJECTED)";
  const failures: string[] = [];
  const ownershipProbe = childProcess.spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" });
  if (ownershipProbe.status !== 0) {
    assert.match(ownershipProbe.stderr ?? ownershipProbe.error?.message ?? "", /Operation not permitted|EPERM/);
    const diagnostic = childProcess.spawnSync("/bin/sh", ["-c", authenticationPipeBroker, "auth-broker", "/usr/bin/script", ...(process.platform === "darwin" ? ["-q", "/dev/null", "/usr/bin/printf", "PTY_OK"] : ["-q", "-e", "-c", "/usr/bin/printf PTY_OK", "/dev/null"])], { encoding: "utf8", input: "", timeout: 3000 });
    const text = diagnostic.stdout + diagnostic.stderr;
    assert.doesNotMatch(text, /tcgetattr|ioctl|Operation not supported/i);
    assert.match(text, /openpty: Operation not permitted|PTY_OK/);
    t.skip("Actual PTY integration blocked: sandbox denies ownership ps probe; real pipe diagnostic has no socket/ioctl error" );
    return;
  }
  const transport = spawnAuthenticationPty("/usr/bin/printf", ["%s", value], (message) => failures.push(message));
  let output = "";
  let errors = "";
  transport.child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  transport.child.stderr.on("data", (data: Buffer) => { errors += data.toString(); });
  const timer = setTimeout(() => transport.kill("SIGKILL"), 3000);
  t.after(() => { clearTimeout(timer); transport.dispose(); });
  const code = await new Promise<number | null>((resolve) => transport.child.once("close", resolve));
  assert.doesNotMatch(output + errors, /tcgetattr|ioctl|Inappropriate ioctl|Operation not supported/i);
  if (/openpty: Operation not permitted/.test(errors + output)) {
    t.skip("Actual PTY integration blocked by sandbox openpty EPERM; socket/ioctl regression absent");
    return;
  }
  assert.equal(code, 0, errors);
  assert.deepEqual(failures, []);
  assert.equal(output, value);
});
