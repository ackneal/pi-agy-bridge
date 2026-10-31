import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeIPC } from "../../bridge/ipc.ts";
import { LiveSession } from "../../session/session.ts";
import { prepareRuntime } from "./prepare.ts";
import { RuntimeSession } from "./runtime.ts";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

for (const scenario of ["rebuild", "cleanup failure", "cancel"] as const) {
  test(`loaded ACP model failure: ${scenario}`, async t => {
    const dir = await mkdtemp(join(tmpdir(), "resume-cleanup-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const log = join(dir, "events");
    const live = new LiveSession("cleanup-test");
    const controller = new AbortController();
    const entered = barrier();
    const gate = barrier();
    const abortEntered = barrier();
    const abortGate = barrier();
    t.after(async () => {
      gate.release();
      abortGate.release();
      await live.dispose();
      await rm(dir, { recursive: true, force: true });
    });
    const events = async (): Promise<{ event: string; pid: number }[]> =>
      (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    let bridge: BridgeIPC | undefined;
    let failed: RuntimeSession | undefined;
    let starts = 0;
    let deletes = 0;
    const close = BridgeIPC.prototype.close;
    const abort = RuntimeSession.prototype.abort;
    t.mock.method(BridgeIPC.prototype, "start", async function (this: BridgeIPC) {
      starts++;
      if (starts === 2) {
        assert.equal(live.activeProcess, null);
        assert.equal(live.activeMcpServer, null);
        assert.equal(failed?.isRunning, false);
        assert.throws(() => bridge!.bridgeUri, /not been started/);
        const pid = (await events())[0]!.pid;
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
      // Isolate socket acquisition; exercise real close/unlink and a real ACP child.
      // IPC protocol behavior is covered by the bridge tests, not this startup test.
      const socketPath = join(dir, `bridge-${starts}.sock`);
      await writeFile(socketPath, "socket acquisition fixture");
      (this as unknown as { socketPath: string }).socketPath = socketPath;
    });
    t.mock.method(BridgeIPC.prototype, "close", async function (this: BridgeIPC) {
      if (!bridge) {
        bridge = this;
        entered.release();
        await gate.promise;
        await close.call(this);
        if (scenario === "cleanup failure") throw new Error("bridge cleanup failed");
        return;
      }
      return close.call(this);
    });
    t.mock.method(RuntimeSession.prototype, "abort", async function (this: RuntimeSession) {
      if (!failed) {
        failed = this;
        abortEntered.release();
        await abortGate.promise;
      }
      await abort.call(this);
    });
    const pending = prepareRuntime({ id: "selected" } as Parameters<typeof prepareRuntime>[0],
      { messages: [] }, [], [], { signal: controller.signal }, {
        cwd: process.cwd(),
        resolve: async () => ({
          executable: process.execPath, cwd: process.cwd(),
          args: ["--experimental-strip-types", fileURLToPath(new URL("./resume-cleanup-fixture.ts", import.meta.url)), log],
        }),
      }, {
        store: { get: async () => undefined, delete: async () => { deletes++; } },
        sync: { decide: () => ({ action: "resume", conversationId: "saved" }) }, sessionVersion: "test",
      }, live, live.beginPreparation());
    const settled = pending.then(value => ({ value }), error => ({ error }));

    await entered.promise;
    assert.deepEqual((await events()).map(entry => entry.event), ["loaded", "model-failed"]);
    assert.equal(starts, 1);
    assert.equal(deletes, 0);
    assert.equal(live.activeProcess, null);
    assert.equal(live.activeMcpServer, null);
    if (scenario === "cancel") controller.abort(new Error("cancel cleanup"));
    gate.release();
    await abortEntered.promise;
    assert.equal(starts, 1);
    assert.equal(deletes, 0);
    abortGate.release();
    const result = await settled;
    if (scenario === "rebuild") {
      assert.ok("value" in result);
      assert.equal(result.value.reconstructContext, true);
      assert.equal(live.activeProcess, result.value.proc);
      assert.equal(live.activeMcpServer, result.value.mcpServer);
      assert.equal(deletes, 1);
      assert.deepEqual((await events()).map(entry => entry.event), ["loaded", "model-failed", "new"]);
    } else {
      assert.ok("error" in result);
      assert.match(String(result.error), scenario === "cancel" ? /cancel cleanup/ : /cleanup failed/);
      assert.equal(starts, 1);
      assert.equal(deletes, 0);
      assert.equal(live.activeProcess, null);
      assert.equal(live.activeMcpServer, null);
    }
  });
}
