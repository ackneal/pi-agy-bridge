import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const scenario = process.argv[2];
const requests: unknown[] = [];
const settings: Record<string, string> = { mode: "yolo", model: "default", thinking_level: "low" };
const configuration = (): acp.SessionConfigOption[] => Object.entries(settings)
  .filter(([id]) => scenario !== "missing-model" || id !== "model")
  .map(([id, currentValue]) => ({
  id, name: id, type: "select", currentValue,
  options: (id === "mode" ? ["default", "auto_edit", "yolo"] : id === "model" ? ["default", "selected"] : ["low", "high"]).map((value) => ({ value, name: value })),
}));

function checkSession(params: acp.NewSessionRequest | acp.LoadSessionRequest): void {
  const meta = params._meta?.antigravity as { enabledTools?: unknown } | undefined;
  if (!Array.isArray(meta?.enabledTools) || meta.enabledTools.length !== 0) throw new Error("Native tools must be disabled");
  if (params.mcpServers.length !== 1 || params.mcpServers[0]?.name !== "pi-agy-bridge_pi") throw new Error("Expected shared Pi MCP");
  requests.push(params);
}

const connection = acp.agent()
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: scenario !== "no-load" },
  }))
  .onRequest(acp.methods.agent.session.new, async ({ params, client }) => {
    checkSession(params);
    if (scenario === "hang-new") await new Promise(() => {});
    await client.notify(acp.methods.client.session.update, {
      sessionId: "synthetic-session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "preparation-output" } },
    });
    const configOptions = scenario === "missing-settings" ? [] : configuration();
    return { sessionId: "synthetic-session", configOptions };
  })
  .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
    checkSession(params);
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "historical-replay" } },
    });
    return { configOptions: configuration() };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    requests.push(params);
    if (scenario !== "reject-settings" && !(scenario === "reject-model" && params.configId === "model") &&
      !(scenario === "reject-effort" && params.configId === "thinking_level")) {
      settings[params.configId] = String(params.value);
    }
    if (scenario === "reset-model" && params.configId === "thinking_level") settings.model = "default";
    return { configOptions: configuration() };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    if (scenario === "hang-prompt") await new Promise(() => {});
    await client.notify(acp.methods.client.session.update, {
      sessionId: "another-session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "unrelated" } },
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(requests) } },
    });
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, () => {})
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
await connection.closed;
