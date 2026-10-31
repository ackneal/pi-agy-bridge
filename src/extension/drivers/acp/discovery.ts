import * as acp from "@agentclientprotocol/sdk";
import type { Api, Model } from "@earendil-works/pi-ai";
import { modelDefaults, UNSUPPORTED_THINKING_LEVELS } from "../../discovery/model-metadata.ts";
import { Connection, type ConnectionOptions } from "./connection.ts";

export type DiscoveryOptions = Pick<ConnectionOptions, "executable" | "cwd" | "args" | "requestTimeoutMs" | "allowInteractiveAuthentication">;

export async function withDiscovery<T>(options: DiscoveryOptions, signal: AbortSignal | undefined,
  operation: (connection: Connection, initialized: acp.InitializeResponse) => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  const connection = new Connection({
    ...options,
    requestTimeoutMs: options.requestTimeoutMs ?? (options.allowInteractiveAuthentication ? 180_000 : 30_000),
  });
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

export async function newDiscoverySession(connection: Connection, cwd: string): Promise<acp.NewSessionResponse> {
  const session = await connection.request(acp.methods.agent.session.new, {
    cwd, mcpServers: [], _meta: { antigravity: { enabledTools: [] } },
  });
  if (!session.sessionId.trim()) throw new Error("ACP server returned an empty session ID");
  return session;
}

export async function discoverModels(options: DiscoveryOptions, signal?: AbortSignal): Promise<Model<Api>[] | undefined> {
  try {
    return await withDiscovery({ ...options, allowInteractiveAuthentication: false }, signal, async (connection) => {
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
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof acp.RequestError && error.code === -32000) return undefined;
    throw error;
  }
}
