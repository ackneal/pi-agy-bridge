import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { probeAgyAuthentication } from "./auth.ts";

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

      // Handle rejection immediately, including when cancellation precedes our assertion.
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
      // ESRCH proves disappearance, not just a delivered signal or a zombie state.
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
