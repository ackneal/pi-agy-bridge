import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpSession } from "./session.ts";
import { AcpConnection } from "./connection.ts";

const cases = [
  { name: "missing append capability", scenario: "no-append", sessionId: undefined, error: /must advertise agentCapabilities\._meta\.antigravity\.systemPrompt\.append === true/ },
  { name: "new session", scenario: "normal", sessionId: undefined, error: undefined },
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
  test(`ACP session configuration: ${row.name}`, async (t) => {
    const updates: acp.SessionNotification[] = [];
    const mcp = { command: "/synthetic/node", args: ["/synthetic/mcp.js", "--endpoint", "unix:///synthetic.sock"] as [string, "--endpoint", string] };
    const session = new AcpSession({
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
  const session = new AcpSession({
    executable: process.execPath,
    args: ["--experimental-strip-types", fileURLToPath(new URL("./session-fixture.ts", import.meta.url)), "hang-prompt"],
    cwd: tmpdir(), mcp: { command: "/synthetic/node", args: ["/synthetic/mcp.js", "--endpoint", "unix:///synthetic.sock"] },
    model: "selected", onUpdate: () => {}, requestTimeoutMs: 5000,
  });
  await session.prepare();
  const rejected = assert.rejects(session.prompt([{ type: "text", text: "pending request" }]));
  const dispose = AcpConnection.prototype.dispose;
  let disposing!: () => void;
  const disposalStarted = new Promise<void>(resolve => { disposing = resolve; });
  t.mock.method(AcpConnection.prototype, "dispose", function (this: AcpConnection) {
    disposing();
    return dispose.call(this);
  });
  // Model transport backpressure, not a slow or unresponsive model request.
  t.mock.method(AcpConnection.prototype, "notify", () => new Promise<void>(() => {}));
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
  test(`ACP session cancellation: ${stage}`, async (t) => {
    const session = new AcpSession({
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
  test(`ACP session read gate: ${phase}`, async (t) => {
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
    const session = new AcpSession({
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
