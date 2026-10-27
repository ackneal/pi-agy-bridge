import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const log = process.argv[2]!;
let resumed = false;
const settings: Record<string, string> = { mode: "default", model: "default" };
const configuration = (): acp.SessionConfigOption[] => Object.entries(settings).map(([id, currentValue]) => ({
  id, name: id, type: "select", currentValue,
  options: (id === "mode" ? ["default"] : ["default", "selected"]).map(value => ({ value, name: value })),
}));
const record = (event: string) => appendFileSync(log, JSON.stringify({ event, pid: process.pid }) + "\n");
// Keep the failed native process alive until the owner's SIGKILL escalation.
process.on("SIGTERM", () => {});
const connection = acp.agent()
  .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true, _meta: { antigravity: { systemPrompt: { append: true } } } } }))
  .onRequest(acp.methods.agent.session.load, () => {
    resumed = true;
    record("loaded");
    return { configOptions: configuration() };
  })
  .onRequest(acp.methods.agent.session.new, () => {
    record("new");
    return { sessionId: "fresh", configOptions: configuration() };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    if (resumed && params.configId === "model") {
      record("model-failed");
      throw new Error("loaded model configuration failed");
    }
    settings[params.configId] = String(params.value);
    return { configOptions: configuration() };
  })
  .onNotification(acp.methods.agent.session.cancel, () => {})
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
await connection.closed;
