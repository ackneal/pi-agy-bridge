// Synthetic lifecycle evidence only: this is not an AGY/model compatibility fixture.
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { PromptResponse } from "@agentclientprotocol/sdk/unstable";
import type { McpToolResult } from "../../src/extension/bridge/capabilities.ts";

// No backend or credential discovery is allowed, including in this subprocess.
globalThis.fetch = async () => { throw new Error("Synthetic contract fixture forbids fetch"); };
const settings: Record<string, string> = { mode: "default", model: "gemini-3.8-flash", thinking_level: "low" };
const configuration = (): acp.SessionConfigOption[] => Object.entries(settings).map(([id, currentValue]) => ({
  id, name: id, type: "select", currentValue, options: [{ value: currentValue, name: currentValue }],
}));
let child: ChildProcessWithoutNullStreams | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function request(method: string, params: unknown): Promise<unknown> {
  assert.ok(child);
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function stop(): void {
  child?.kill("SIGTERM");
  for (const waiter of pending.values()) waiter.reject(new Error("Synthetic MCP transport closed"));
  pending.clear();
}
process.once("SIGTERM", () => { stop(); process.exit(0); });
process.once("exit", stop);

const connection = acp.agent()
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } },
  }))
  .onRequest(acp.methods.agent.session.new, async ({ params }) => {
    assert.equal(params.mcpServers.length, 1);
    const descriptor = params.mcpServers[0]!;
    assert.ok("command" in descriptor);
    assert.equal(descriptor.name, "pi-agy-bridge_pi");
    const meta = params._meta?.antigravity as { enabledTools?: unknown };
    assert.deepEqual(meta.enabledTools, []);
    child = spawn(descriptor.command, descriptor.args, { cwd: params.cwd, stdio: "pipe", env: process.env });
    child.stderr.resume();
    child.once("error", stop);
    child.once("exit", stop);
    createInterface({ input: child.stdout }).on("line", line => {
      const reply = JSON.parse(line) as { id: number; result?: unknown; error?: { message: string } };
      const waiter = pending.get(reply.id);
      assert.ok(waiter, "Only replies to actual MCP requests are accepted");
      pending.delete(reply.id);
      if (reply.error) waiter.reject(new Error(reply.error.message)); else waiter.resolve(reply.result);
    });
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synthetic-contract-audit", version: "1" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return { sessionId: "synthetic-contract-session", configOptions: configuration() };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    assert.equal(params.value, settings[params.configId]);
    return { configOptions: configuration() };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }): Promise<PromptResponse> => {
    const text = params.prompt.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
    let answer: string;
    const call = /Call (mcp__pi__(?:live|pending)_probe) exactly once with (?:arguments )?(\{"value":"[^"]+"\})/.exec(text);
    if (call) {
      const result = await request("tools/call", { name: call[1], arguments: JSON.parse(call[2]!) }) as McpToolResult;
      const output = result.content.flatMap(part => part.type === "text" ? [part.text] : []);
      const receipt = output.filter(part => !part.startsWith("# Pending conversation updates")).join("\n").match(/receipt-[\da-f-]+/i)?.[0];
      assert.ok(receipt, "Receipt must come from the genuine Pi handler result");
      if (call[1] === "mcp__pi__pending_probe") {
        const appendix = output.find(part => part.startsWith("# Pending conversation updates (separate from tool output)"));
        const correction = appendix?.match(/corrected-[\da-f-]+/i)?.[0];
        assert.ok(correction, "Fresh correction must come only from the genuine result appendix");
        answer = `${correction} ${receipt}`;
      } else answer = receipt;
    } else {
      const marker = /Do not use any tools\. Reply with exactly: ([\da-f-]+)/i.exec(text)?.[1];
      assert.ok(marker, "Only known audit prompts are supported");
      answer = marker;
    }

    for (const used of [300, 321]) await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId, update: { sessionUpdate: "usage_update", used, size: 200_000 },
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } },
    });
    return { stopReason: "end_turn", ...(process.argv[2] === "missing-usage" ? {} : {
      usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 10, cachedWriteTokens: 5, thoughtTokens: 7, totalTokens: 127 },
    }) };
  })
  .onNotification(acp.methods.agent.session.cancel, stop)
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
try { await connection.closed; } finally { stop(); }
