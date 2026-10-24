import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const mode = process.argv[2];
if (mode === "descendant" || mode === "descendant-exit") {
  if (process.argv[4]) writeFileSync(process.argv[4], String(process.pid));
  const child = spawn(process.execPath, ["-e", `
    process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 1000);
  `, process.argv[3]!], { stdio: "ignore" });
  child.unref();
}
if (mode === "blocked-stdin") {
  const lines = createInterface({ input: process.stdin });
  lines.once("line", (line) => {
    const request = JSON.parse(line);
    lines.close();
    process.stdin.pause();
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} } }) + "\n");
  });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (mode === "exit") process.exit(23);
process.stderr.write("x".repeat(20_000));
const connection = acp.agent()
  .onRequest(acp.methods.agent.initialize, async ({ params }) => {
    if (mode === "startup-hang") await new Promise(() => {});
    if (params.clientCapabilities?.fs?.readTextFile || params.clientCapabilities?.fs?.writeTextFile || params.clientCapabilities?.terminal) throw new Error("unexpected capabilities");
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    if (mode === "hang") await new Promise(() => {});
    if (mode === "descendant-exit") process.exit(24);
    if (mode === "prompt-exit") process.exit(24);
    const permission = await client.request(acp.methods.client.session.requestPermission, {
      sessionId: params.sessionId, options: [], toolCall: { toolCallId: "fake" },
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: permission.outcome.outcome } },
    });
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, async ({ params, client }) => {
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "cancel" } },
    });
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
await connection.closed;
