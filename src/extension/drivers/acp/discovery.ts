import * as acp from "@agentclientprotocol/sdk";
import type { Api, Model } from "@earendil-works/pi-ai";
import { modelDefaults, UNSUPPORTED_THINKING_LEVELS } from "../../discovery/model-metadata.ts";
import { AcpConnection, type AcpConnectionOptions } from "./connection.ts";

export type AcpDiscoveryOptions = Pick<AcpConnectionOptions, "executable" | "cwd" | "args" | "requestTimeoutMs">;

export async function withAcpDiscovery<T>(options: AcpDiscoveryOptions, signal: AbortSignal | undefined,
  operation: (connection: AcpConnection, initialized: acp.InitializeResponse) => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  const connection = new AcpConnection(options);
  const abort = () => { void connection.dispose().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const initialized = await connection.start(signal);
    signal?.throwIfAborted();
    const result = await operation(connection, initialized);
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
    await connection.dispose();
  }
}

export async function newDiscoverySession(connection: AcpConnection, cwd: string): Promise<acp.NewSessionResponse> {
  const session = await connection.request(acp.methods.agent.session.new, {
    cwd, mcpServers: [], _meta: { antigravity: { enabledTools: [] } },
  });
  if (!session.sessionId.trim()) throw new Error("ACP server returned an empty session ID");
  return session;
}

export async function discoverAcpModels(options: AcpDiscoveryOptions, signal?: AbortSignal): Promise<Model<Api>[]> {
  return withAcpDiscovery(options, signal, async (connection) => {
    const session = await newDiscoverySession(connection, options.cwd);
    const modelOption = session.configOptions?.find((option) => option.id === "model" && option.type === "select");
    if (!modelOption || modelOption.type !== "select") throw new Error("ACP model select configuration is unavailable");
    const values = modelOption.options.flatMap((entry) => "group" in entry ? entry.options : [entry]);
    if (!values.length) throw new Error("ACP model catalog is empty");
    const thinking = session.configOptions?.find((option) => option.id === "thinking_level" && option.type === "select");
    const efforts = thinking?.type === "select" ? thinking.options.flatMap((entry) => "group" in entry ? entry.options : [entry]) : [];
    const thinkingLevelMap = { ...UNSUPPORTED_THINKING_LEVELS } as NonNullable<Model<Api>["thinkingLevelMap"]>;
    for (const effort of efforts) {
      if (Object.hasOwn(thinkingLevelMap, effort.value)) {
        thinkingLevelMap[effort.value as keyof typeof thinkingLevelMap] = effort.value;
      }
    }
    return values.map(({ value, name }) => {
      if (!value.trim()) throw new Error("ACP model catalog contains an empty ID");
      return { ...modelDefaults(value), id: value, name, reasoning: efforts.length > 0, thinkingLevelMap: { ...thinkingLevelMap } };
    });
  });
}
