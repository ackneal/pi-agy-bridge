import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, mkdir, writeFile, readFile, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeSession } from "./runtime.ts";
import { Session } from "./session.ts";
import { Connection } from "./connection.ts";
import type { DriverSubmission } from "../types.ts";

for (const mode of ["abort", "connection close", "prompt rejection", "payload close"] as const) {
  test(mode === "payload close" ? "close during payload preparation keeps one completion owner" : `runtime awaits in-flight client read cleanup after ${mode}`, { timeout: 10_000 }, async (t) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "acp-read-lifecycle-")));
    const previousHome = process.env.GEMINI_HOME;
    process.env.GEMINI_HOME = home;
    let runtime: RuntimeSession | undefined;
    let probe: FileHandle | undefined;
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    try {
      const directory = join(home, "antigravity-acp/brain/synthetic-session/.system_generated/steps");
      await mkdir(directory, { recursive: true });
      const file = join(directory, "result");
      await writeFile(file, "source\n");
      const source = await readFile(new URL("./session-fixture.ts", import.meta.url), "utf8");
      const script = source.replace("const scenario = process.argv[2];", 'const scenario = "normal";')
        .replace('if (scenario === "hang-prompt") await new Promise(() => {});', `
          await client.request(acp.methods.client.fs.readTextFile, { sessionId: params.sessionId, path: ${JSON.stringify(file)} });
        `);
      probe = await open(file, "r");
      const prototype = Object.getPrototypeOf(probe) as FileHandle;
      const read = prototype.read;
      let started!: () => void;
      const reading = new Promise<void>(resolve => { started = resolve; });
      t.mock.method(prototype, "read", async function (this: FileHandle, buffer: Buffer, offset: number, length: number, position: number) {
        started();
        await released;
        return read.call(this, { buffer, offset, length, position });
      });
      runtime = new RuntimeSession({ executable: process.execPath, cwd: process.cwd(), model: "selected",
        args: ["--experimental-strip-types", "--input-type=module-typescript", "-e", script],
        mcp: { command: process.execPath, args: ["unused", "--endpoint", "unused"] } });
      const completions: { reason: string }[] = [];
      let completed!: () => void;
      const completion = new Promise<void>(resolve => { completed = resolve; });
      runtime.onRuntimeEvent(event => {
        if (event.type === "complete") { completions.push(event); completed(); }
      });
      await runtime.prepare();
      let rejectPrompt!: (error: Error) => void;
      if (mode === "prompt rejection") {
        const rejected = new Promise<never>((_, reject) => { rejectPrompt = reject; });
        const request = Connection.prototype.request;
        t.mock.method(Connection.prototype, "request", function (this: Connection,
          method: Parameters<Connection["request"]>[0], params: Parameters<Connection["request"]>[1]) {
          const pending = request.call(this, method, params);
          // An RPC error can reject the prompt while its transport remains open.
          return method === "session/prompt" ? Promise.race([pending, rejected]) : pending;
        });
      }
      const disposal = t.mock.method(Session.prototype, "dispose");
      const proc = runtime;
      let closing: Promise<void> | undefined;
      let accepted = 0;
      const input: DriverSubmission = {
        model: { id: "selected", name: "Synthetic", api: "anthropic-messages", provider: "anthropic",
          baseUrl: "https://example.invalid", input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          reasoning: false, contextWindow: 1000, maxTokens: 100 },
        messages: [{ role: "user", content: "Read the result" }],
        options: mode === "payload close" ? { onPayload: payload => {
          closing = proc.session.dispose();
          return payload;
        } } : undefined,
        beforeInput: () => { accepted++; return true; },
      };
      if (mode === "payload close") {
        const rejection = await runtime.submit(input).then(() => undefined, error => error);
        await closing;
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepEqual({ rejected: rejection instanceof Error, accepted, completions: completions.map(event => event.reason) },
          { rejected: true, accepted: 0, completions: ["error"] });
        return;
      }
      await runtime.submit(input);
      await reading;
      if (mode !== "abort") {
        if (mode === "connection close") await runtime.session.dispose();
        else rejectPrompt(new Error("synthetic prompt rejection with an open transport"));
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(completions.length, 0, "failure must not complete before read cleanup");
        release();
        await completion;
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepEqual(completions.map(event => event.reason), ["error"], "close and prompt rejection must complete only once");
        if (mode === "prompt rejection") {
          assert.equal(disposal.mock.callCount(), 1, "fail() disposal must not create another completion owner through onClose");
        }
      } else {
        let transportClosed!: () => void;
        const closed = new Promise<void>(resolve => { transportClosed = resolve; });
        const cancel = Session.prototype.cancel;
        t.mock.method(Session.prototype, "cancel", async function (this: Session) {
          try { await cancel.call(this); }
          finally { transportClosed(); }
        });
        let stopped = false;
        const stopping = runtime.abort().finally(() => { stopped = true; });
        await closed;
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(stopped, false, "runtime must still own the in-flight file read after transport shutdown");
        release();
        await stopping;
        assert.equal(stopped, true);
      }
      assert.equal(runtime.isRunning, false);
    } finally {
      release();
      await runtime?.abort();
      await probe?.close();
      if (previousHome === undefined) delete process.env.GEMINI_HOME;
      else process.env.GEMINI_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });
}
