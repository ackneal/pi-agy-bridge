import assert from "node:assert/strict";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { Connection } from "./connection.ts";

// Exercise the real SDK transport without depending on an installed agent.
const agent = `
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    if (process.env.ACP_TEST_MODE === 'startup-hang') return;
    send({ id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({ method: 'session/update', params: {
      sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } }
    } });
    send({ id: message.id, result: { sessionId: 'session-1' } });
  } else if (message.method === 'session/prompt') {
  } else if (message.method === 'session/cancel') {
    send({ id: 'permission', method: 'session/request_permission', params: {
      sessionId: 'session-1', toolCall: { toolCallId: 'call-1' }, options: []
    } });
    send({ id: 'filesystem', method: 'fs/read_text_file', params: { sessionId: 'session-1', path: '/etc/passwd' } });
  } else if (message.error) {
    send({ method: 'session/update', params: {
      sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(message) } }
    } });
  }
});
`;

for (const scenario of ["subscriptions", "already cancelled", "startup cancellation", "startup timeout", "request timeout", "prompt cancellation", "spawn failure", "client security"] as const) {
  test(`Connection: ${scenario}`, async () => {
    const exitListenerCount = process.listenerCount("exit");
    const controller = new AbortController();
    const reason = new Error("test cancellation");
    const connection = new Connection({
      executable: scenario === "spawn failure" ? "/nonexistent/acp-test-executable" : process.execPath,
      args: ["-e", agent],
      cwd: process.cwd(),
      environment: { ACP_TEST_MODE: scenario === "startup cancellation" || scenario === "startup timeout" ? "startup-hang" : "normal" },
      requestTimeoutMs: scenario === "request timeout" || scenario === "startup timeout" ? 200 : 5000,
    });

    try {
      if (scenario === "already cancelled") {
        controller.abort(reason);
        await assert.rejects(connection.start(controller.signal), (error) => error === reason);
        assert.equal(connection.isRunning, false);
        return;
      }

      if (scenario === "startup timeout") {
        await assert.rejects(connection.start(), /ACP request timeout: initialize/);
        assert.equal(connection.isRunning, false);
        return;
      }

      if (scenario === "startup cancellation") {
        const starting = connection.start(controller.signal);
        controller.abort(reason);
        await assert.rejects(starting, (error) => error === reason);
        assert.equal(connection.isRunning, false);
        return;
      }

      if (scenario === "spawn failure") {
        await assert.rejects(connection.start(), /ENOENT/);
        assert.equal(connection.isRunning, false);
        return;
      }

      await connection.start();
      assert.equal(connection.isRunning, true);

      if (scenario === "subscriptions") {
        const updates: acp.SessionNotification[] = [];
        const removed: acp.SessionNotification[] = [];
        const unsubscribe = connection.onSessionUpdate((update) => { updates.push(update); });
        const removeOther = connection.onSessionUpdate((update) => { removed.push(update); });
        removeOther();
        removeOther();

        await connection.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
        assert.equal(updates.length, 1);
        assert.equal(updates[0]?.sessionId, "session-1");
        assert.deepEqual(updates[0]?.update, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } });
        assert.deepEqual(removed, []);

        unsubscribe();
        await connection.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
        assert.equal(updates.length, 1);
      } else if (scenario === "client security") {
        const replies: { id: string; error: { code: number } }[] = [];
        let complete!: () => void;
        const received = new Promise<void>((resolve) => { complete = resolve; });
        connection.onSessionUpdate(({ update }) => {
          if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return;
          replies.push(JSON.parse(update.content.text));
          if (replies.length === 2) complete();
        });

        await connection.notify(acp.methods.agent.session.cancel, { sessionId: "session-1" });
        await received;
        assert.deepEqual(replies.map(({ id, error }) => [id, error.code]), [["permission", -32601], ["filesystem", -32601]]);
      } else {
        const pending = scenario === "request timeout"
          ? connection.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] }).then(() => connection.request("_test/hang", {}))
          : connection.request(acp.methods.agent.session.prompt, { sessionId: "session-1", prompt: [] });

        if (scenario === "prompt cancellation") {
          // Prompt requests intentionally have no request deadline, but disposal must settle them.
          const rejected = assert.rejects(pending, /ACP connection disposed/);
          const disposal = connection.dispose();
          assert.equal(connection.dispose(), disposal);
          await Promise.all([rejected, disposal]);
        } else {
          await assert.rejects(pending, /ACP request timeout: _test\/hang/);
        }
        assert.equal(connection.isRunning, false);
      }

      await connection.dispose();
      await assert.rejects(connection.start(), /ACP/);
      await assert.rejects(connection.request(acp.methods.agent.session.new, {}), /ACP/);
    } finally {
      await connection.dispose();
      assert.equal(process.listenerCount("exit"), exitListenerCount);
    }
  });
}

for (const requestTimeoutMs of [0, -1, Infinity, NaN]) {
  test(`Connection rejects invalid timeout ${requestTimeoutMs}`, () => {
    assert.throws(() => new Connection({ executable: process.execPath, cwd: process.cwd(), requestTimeoutMs }), /positive and finite/);
  });
}
