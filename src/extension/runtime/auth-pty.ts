import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Duplex } from "node:stream";

export interface AuthenticationPty {
  child: ChildProcessWithoutNullStreams;
  kill(signal: NodeJS.Signals): void;
  dispose(): void;
}

const failureMessage = "Could not start an interactive terminal for Antigravity CLI authentication";
const targetWrapper = 'pgid=$(/bin/ps -o pgid= -p "$$") || exit 1; printf "%s %s\\n" "$$" "$pgid" >&3 || exit 1; exec 3>&-; IFS= read -r gate <&4 || exit 1; exec 4<&-; [ "$gate" = start ] || exit 1; exec "$@"';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// The pipe header identifies the producer before it execs cat. Stop it before
// the root shell waits for both pipeline jobs, preserving the consumer status.
export const authenticationPipeBroker = '/bin/sh -c \'printf "%s\\n" "$$"; exec /bin/cat\' 3>&- 4<&- | { IFS= read -r producer || exit 1; "$@"; status=$?; kill -KILL "$producer" 2>/dev/null; exit "$status"; }';

export function spawnAuthenticationPty(executable: string, args: readonly string[], onFailure: (message: string) => void): AuthenticationPty {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error(failureMessage);
  const applicationGroup = Number(spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8", timeout: 2000 }).stdout?.trim());
  if (!Number.isSafeInteger(applicationGroup) || applicationGroup <= 0) throw new Error(failureMessage);

  const target = ["/bin/sh", "-c", targetWrapper, "auth-target", executable, ...args];
  const scriptArgs = process.platform === "darwin"
    ? ["-q", "/dev/null", ...target]
    : ["-q", "-e", "-c", `exec ${target.map(quote).join(" ")}`, "/dev/null"];
  // cat converts Node's socket-backed stdin to a POSIX pipe for BSD script.
  const child = spawn("/bin/sh", ["-c", authenticationPipeBroker, "auth-broker", "/usr/bin/script", ...scriptArgs], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const control = child.stdio[3] as Duplex;
  const gate = child.stdio[4] as Duplex;
  let frame = "";
  let targetGroup: number | undefined;
  let cancelled = false;
  let failed = false;
  let closed = false;
  let disposed = false;
  let lastSignal: NodeJS.Signals = "SIGTERM";

  const signalGroup = (group: number | undefined, signal: NodeJS.Signals) => {
    if (!group || group === process.pid || group === applicationGroup) return;
    try { process.kill(-group, signal); } catch { /* Already exited. */ }
  };
  const kill = (signal: NodeJS.Signals) => {
    cancelled = true;
    lastSignal = signal;
    gate.destroy();
    signalGroup(targetGroup, signal);
    if (!closed) signalGroup(child.pid, signal);
  };
  const fail = () => {
    if (failed) return;
    failed = true;
    kill("SIGKILL");
    onFailure(failureMessage);
  };
  const onData = (chunk: Buffer) => {
    if (failed) return;
    if (targetGroup !== undefined || Buffer.byteLength(frame) + chunk.length >= 128) { fail(); return; }
    frame += chunk.toString("utf8");
    if (!frame.includes("\n")) return;
    const match = /^([1-9][0-9]*) +([1-9][0-9]*)\n$/.exec(frame);
    const pid = Number(match?.[1]);
    const pgid = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(pid) || pid > 2147483647 || pid !== pgid || pid === process.pid || pid === child.pid || pid === applicationGroup) {
      fail(); return;
    }
    targetGroup = pid;
    if (cancelled) signalGroup(targetGroup, lastSignal);
    else gate.end("start\n");
  };
  const onEnd = () => { if (targetGroup === undefined && !cancelled) fail(); };
  const onError = () => fail();
  const cleanup = () => {
    control.off("data", onData);
    control.off("end", onEnd);
    control.off("error", onError);
    gate.off("error", onError);
    control.destroy();
    gate.destroy();
    child.off("error", onError);
    child.off("close", onClose);
  };
  const onClose = () => {
    closed = true;
    signalGroup(targetGroup, "SIGKILL");
    if (!cancelled && targetGroup === undefined) fail();
    if (disposed) cleanup();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    kill("SIGKILL");
    if (closed) cleanup();
  };

  control.on("data", onData);
  control.on("end", onEnd);
  control.on("error", onError);
  gate.on("error", onError);
  child.on("error", onError);
  child.on("close", onClose);
  return { child, kill, dispose };
}
