import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import type { DriverSubmission, RuntimeEvent } from "../types.ts";
import { ArtifactReader } from "./artifact-reader.ts";
import { Connection } from "./connection.ts";
import { RuntimeSession } from "./runtime.ts";
import { Session } from "./session.ts";

describe("Session configuration and lifecycle", () => {
  const cases = [
    { name: "missing append capability", scenario: "no-append", sessionId: undefined, error: /must advertise agentCapabilities\._meta\.antigravity\.systemPrompt\.append === true/ },
    { name: "creates a session and applies mode, model and effort", scenario: "normal", sessionId: undefined, error: undefined },
    { name: "load suppresses replay and reapplies settings", scenario: "normal", sessionId: "loaded-session", error: undefined },
    { name: "missing mode config", scenario: "missing-settings", sessionId: undefined, error: /configuration is unavailable: mode/ },
    { name: "missing model config", scenario: "missing-model", sessionId: undefined, error: /configuration is unavailable: model/ },
    { name: "rejected default mode", scenario: "reject-settings", sessionId: undefined, error: /did not apply the requested mode/ },
    { name: "rejected model config", scenario: "reject-model", sessionId: undefined, error: /did not apply the requested model/ },
    { name: "rejected effort config", scenario: "reject-effort", sessionId: undefined, error: /did not apply the requested thinking_level/ },
    { name: "effort change resets model", scenario: "reset-model", sessionId: undefined, error: /did not apply the requested model/ },
    { name: "load unsupported", scenario: "no-load", sessionId: "loaded-session", error: /does not support session loading/ },
  ];

  for (const row of cases) {
    test(`Session.prepare configuration: ${row.name}`, async (t) => {
      const updates: acp.SessionNotification[] = [];
      const mcp = { command: "/synthetic/node", args: ["/synthetic/mcp.js", "--endpoint", "unix:///synthetic.sock"] as [string, "--endpoint", string] };
      const session = new Session({
        executable: process.execPath,
        args: ["--experimental-strip-types", fileURLToPath(new URL("./session-fixture.ts", import.meta.url)), row.scenario],
        cwd: tmpdir(), mcp, model: "selected", effort: "high", systemPrompt: "synthetic system prompt",
        ...(row.sessionId ? { sessionId: row.sessionId } : {}),
        onUpdate: (notification) => { updates.push(notification); },
        requestTimeoutMs: 5000,
      });
      t.after(() => session.dispose());

      if (row.error) {
        await assert.rejects(session.prepare(), row.error);
        assert.equal(session.isRunning, false);
        assert.equal(updates.length, 0);
        return;
      }
      await session.prepare();
      assert.equal(updates.length, 0);
      assert.equal(session.id, row.sessionId ?? "synthetic-session");
      assert.equal(session.isRunning, true);
      const response = await session.prompt([{ type: "text", text: "synthetic prompt" }]);

      assert.equal(response.stopReason, "end_turn");
      assert.equal(session.hasActivePrompt, false);
      assert.equal(updates.length, 1);
      const update = updates[0]!.update;
      assert.equal(update.sessionUpdate, "agent_message_chunk");
      assert.ok("content" in update && update.content.type === "text");
      const requests = JSON.parse(update.content.text);
      assert.deepEqual(requests[0], {
        cwd: tmpdir(),
        mcpServers: [{ name: "pi-agy-bridge_pi", command: mcp.command, args: mcp.args, env: [] }],
        _meta: { antigravity: { enabledTools: [], systemPrompt: { append: "synthetic system prompt" } } },
        ...(row.sessionId ? { sessionId: row.sessionId } : {}),
      });
      assert.deepEqual(requests.slice(1), [
        { sessionId: session.id, configId: "mode", value: "default" },
        { sessionId: session.id, configId: "model", value: "selected" },
        { sessionId: session.id, configId: "thinking_level", value: "high" },
      ]);
    });
  }

  test("cancellation backpressure cannot delay native process disposal", async (t) => {
    const session = new Session({
      executable: process.execPath,
      args: ["--experimental-strip-types", fileURLToPath(new URL("./session-fixture.ts", import.meta.url)), "hang-prompt"],
      cwd: tmpdir(), mcp: { command: "/synthetic/node", args: ["/synthetic/mcp.js", "--endpoint", "unix:///synthetic.sock"] },
      model: "selected", onUpdate: () => {}, requestTimeoutMs: 5000,
    });
    await session.prepare();
    const rejected = assert.rejects(session.prompt([{ type: "text", text: "pending request" }]));
    const dispose = Connection.prototype.dispose;
    let disposing!: () => void;
    const disposalStarted = new Promise<void>(resolve => { disposing = resolve; });
    t.mock.method(Connection.prototype, "dispose", function (this: Connection) {
      disposing();
      return dispose.call(this);
    });
    t.mock.method(Connection.prototype, "notify", () => new Promise<void>(() => {}));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const cancelled = session.cancel();
      await Promise.race([disposalStarted, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Cancellation transport blocked process disposal")), 1000);
      })]);
      await cancelled;
      await rejected;
      assert.equal(session.isRunning, false);
      assert.equal(session.hasActivePrompt, false);
    } finally {
      clearTimeout(deadline);
      t.mock.restoreAll();
      await session.dispose();
      await rejected;
    }
  });

  for (const stage of ["preparation", "prompt"] as const) {
    test(`Session cancellation stops the process and clears the active prompt during ${stage}`, async (t) => {
      const session = new Session({
        executable: process.execPath,
        args: ["--experimental-strip-types", fileURLToPath(new URL("./session-fixture.ts", import.meta.url)), stage === "preparation" ? "hang-new" : "hang-prompt"],
        cwd: tmpdir(), mcp: { command: "/synthetic/node", args: ["/synthetic/mcp.js", "--endpoint", "unix:///synthetic.sock"] },
        model: "selected", onUpdate: () => {}, requestTimeoutMs: 5000,
      });
      t.after(() => session.dispose());
      const controller = new AbortController();
      if (stage === "preparation") {
        const preparation = session.prepare(controller.signal);
        const rejected = assert.rejects(preparation);
        setTimeout(() => controller.abort(), 200);
        await rejected;
      } else {
        await session.prepare();
        const prompt = session.prompt([{ type: "text", text: "synthetic prompt" }]);
        const rejected = assert.rejects(prompt);
        await assert.rejects(session.prompt([{ type: "text", text: "must not resend" }]), /already has an active prompt/);
        assert.equal(session.hasActivePrompt, true);
        await session.cancel();
        await rejected;
      }
      assert.equal(session.isRunning, false);
      assert.equal(session.hasActivePrompt, false);
      await session.dispose();
    });
  }

  for (const phase of ["preparation", "active", "wrong-session", "idle"] as const) {
    test(`Session read gate allows only the active conversation prompt: ${phase}`, async (t) => {
      const source = await readFile(new URL("./session-fixture.ts", import.meta.url), "utf8");
      const read = `
        let report;
        try { report = await client.request(acp.methods.client.fs.readTextFile, {
          sessionId: ${JSON.stringify(phase === "wrong-session" ? "another-session" : "synthetic-session")}, path: '/synthetic/artifact'
        }); } catch (error) { report = { code: error.code, message: error.message }; }
      `;
      const notify = `await client.notify(acp.methods.client.session.update, {
        sessionId: 'synthetic-session', update: { sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: JSON.stringify(report) } }
      });`;
      const script = source.replace('const scenario = process.argv[2];', 'const scenario = "normal";')
        .replace('checkSession(params);', phase === "preparation" ? `${read} requests.push(report); checkSession(params);` : 'checkSession(params);')
        .replace('if (scenario === "hang-prompt") await new Promise(() => {});',
          phase === "preparation" ? '' : phase === "idle"
            ? `setTimeout(async () => { ${read} ${notify} }, 50); return { stopReason: 'end_turn' };`
            : `${read} ${notify} return { stopReason: 'end_turn' };`);
      const calls: acp.ReadTextFileRequest[] = [];
      const controller = new AbortController();
      let received!: (value: unknown) => void;
      const report = new Promise<unknown>((resolve) => { received = resolve; });
      const session = new Session({
        executable: process.execPath, args: ["--experimental-strip-types", "--input-type=module-typescript", "-e", script],
        cwd: process.cwd(), model: "selected",
        mcp: { command: process.execPath, args: ["unused", "--endpoint", "unused"] },
        onRead: async (request, signal) => {
          assert.equal(signal.aborted, false);
          assert.ok(signal instanceof AbortSignal);
          calls.push(request);
          return { content: "allowed" };
        },
        onUpdate: ({ update }) => {
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            const value = JSON.parse(update.content.text);
            received(phase === "preparation" ? value[0] : value);
          }
        },
      });
      t.after(() => session.dispose());
      await session.prepare(controller.signal);
      await session.prompt([{ type: "text", text: "read artifact" }]);
      const value = await report;
      if (phase === "active") {
        assert.deepEqual(value, { content: "allowed" });
        assert.deepEqual(calls, [{ sessionId: session.id, path: "/synthetic/artifact" }]);
      } else {
        assert.deepEqual(value, { code: -32000, message: "ACP read is outside the active conversation prompt" });
        assert.deepEqual(calls, []);
      }
    });
  }
});

describe("RuntimeSession cleanup failure and client read lifecycle", () => {
  for (const mode of ["prompt rejection", "prompt success", "transport close", "synchronous close", "abort"] as const) {
    test(`cleanup rejection preserves completion after ${mode}`, async (t) => {
      const runtime = new RuntimeSession({ executable: "unused", cwd: process.cwd(), model: "selected",
        mcp: { command: process.execPath, args: ["unused", "--endpoint", "unused"] } });
      const sessionOptions = (runtime.session as unknown as { options: { onClose: (error: unknown) => void } }).options;
      const state = runtime as unknown as { completion: Promise<void> | undefined };
      const events: RuntimeEvent[] = [];
      runtime.onRuntimeEvent(event => events.push(event));
      t.mock.getter(Session.prototype, "isRunning", () => true);
      t.mock.getter(Session.prototype, "id", () => "synthetic-session");
      const original = new Error("original runtime failure");
      const end = t.mock.method(ArtifactReader.prototype, "endPrompt", async () => { throw new Error("reader cleanup failure"); });
      const dispose = t.mock.method(Session.prototype, "dispose", async () => {
        sessionOptions.onClose(original);
        throw new Error("session disposal failure");
      });
      t.mock.method(Session.prototype, "cancel", async () => { sessionOptions.onClose(original); });
      t.mock.method(Session.prototype, "prompt", async () => {
        if (mode === "prompt success") return { stopReason: "end_turn" as const };
        if (mode === "synchronous close") sessionOptions.onClose(original);
        throw original;
      });
      const input: DriverSubmission = {
        model: { id: "selected", name: "Synthetic", api: "anthropic-messages", provider: "anthropic",
          baseUrl: "https://example.invalid", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          reasoning: false, contextWindow: 1000, maxTokens: 100 },
        messages: [{ role: "user", content: "hello" }],
        options: undefined, beforeInput: () => true,
      };
      if (mode === "prompt rejection" || mode === "prompt success" || mode === "synchronous close") {
        await runtime.submit(input);
        const completion = state.completion!;
        await new Promise<void>(resolve => setImmediate(resolve));
        await assert.doesNotReject(completion);
      } else if (mode === "transport close") {
        sessionOptions.onClose(original);
        const completion = state.completion!;
        await new Promise<void>(resolve => setImmediate(resolve));
        await assert.doesNotReject(completion);
      } else {
        await assert.rejects(runtime.abort(), /reader cleanup failure/);
        await assert.doesNotReject(state.completion ?? Promise.resolve());
      }
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.ok(end.mock.callCount() > 0);
      assert.equal(dispose.mock.callCount(), 1);
      const terminal = events.filter(event => event.type === "complete");
      assert.equal(terminal.length, mode === "abort" ? 0 : 1);
      if (mode !== "abort") {
        assert.equal(terminal[0]?.reason, "error");
        assert.match(terminal[0]?.error ?? "", mode === "prompt success" ? /reader cleanup failure/ : /original runtime failure/);
      }
    });
  }

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
});
