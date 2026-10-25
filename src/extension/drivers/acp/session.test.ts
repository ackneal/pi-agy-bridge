import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpSession } from "./session.ts";

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
