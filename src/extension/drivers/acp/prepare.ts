import type { Context, Model, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import { BridgeIPC } from "../../bridge/bridge-ipc.ts";
import { createMcpLaunchDescriptor } from "../../bridge/mcp-launch.ts";
import { calculateSyncKey, type LiveSession } from "../../session/session.ts";
import type { RuntimeSessionStore, RuntimeSessionSync } from "../../session/session-state.ts";
import type { AgyBridgeConfig } from "../../shared/types.ts";
import { resolveAcpConnectionOptions, resolveAcpEffort } from "./options.ts";
import { debugLog } from "../../shared/debug.ts";
import { AcpRuntimeSession } from "./runtime.ts";

export async function prepareAcpRuntime(
  model: Model<any>, context: Context, tools: readonly Tool[], options: SimpleStreamOptions | undefined,
  config: AgyBridgeConfig | undefined,
  dependencies: { store: Pick<RuntimeSessionStore, "get" | "delete">; sync: Pick<RuntimeSessionSync, "decide" | "getSyncedMessageCount"> },
  liveSession: LiveSession, preparationId: symbol,
): Promise<{ proc: AcpRuntimeSession; mcpServer: BridgeIPC; reconstructContext: boolean; modelId: string }> {
  const check = () => {
    options?.signal?.throwIfAborted();
    if (!liveSession.ownsPreparation(preparationId)) throw new Error("ACP preparation superseded");
  };
  check();
  const connection = resolveAcpConnectionOptions(config);
  const requested = resolveAcpEffort(model, options);
  const syncKey = calculateSyncKey(context.systemPrompt, tools.map((tool) => JSON.stringify(tool)), model.id, requested, "acp");
  if (liveSession.driverId !== "acp") {
    await liveSession.dispose({ preparationId });
    check();
  }
  const checkpoint = await dependencies.store.get(liveSession.piSessionId, options?.env?.AGY_BRIDGE_LOGIN_EPOCH, "acp");
  check();
  const latest = [...context.messages].reverse().find((message) => message.role === "assistant");
  const decision = dependencies.sync.decide(liveSession, {
    syncKey, messages: context.messages,
    ...(latest?.responseId ? { conversationId: latest.responseId } : {}),
    ...(checkpoint ? { checkpoint } : {}),
  });
  if (decision.action === "continue" && liveSession.activeProcess instanceof AcpRuntimeSession && liveSession.activeMcpServer) {
    const proc = liveSession.activeProcess;
    const matches = proc.options.model === model.id && proc.options.effort === requested;
    return { proc, mcpServer: liveSession.activeMcpServer, reconstructContext: false, modelId: matches ? model.id : latest?.model ?? proc.options.model };
  }
  await liveSession.dispose({ preparationId, preserveConversation: decision.action === "resume", preserveResources: decision.action === "resume" && decision.conversationId === liveSession.conversationId });
  check();

  const startRuntime = async (conversationId?: string) => {
    check();
    const bridge = new BridgeIPC(tools, liveSession.id, liveSession.resources);
    let proc: AcpRuntimeSession | undefined;
    const cancel = () => {
      void bridge.close().catch((error) => debugLog("session", "Error closing cancelled ACP MCP startup:", error));
      void proc?.abort().catch((error) => debugLog("session", "Error cancelling ACP startup:", error));
    };
    options?.signal?.addEventListener("abort", cancel, { once: true });
    try {
      await bridge.start();
      check();
      proc = new AcpRuntimeSession({
        ...connection,
        mcp: createMcpLaunchDescriptor(bridge.bridgeUri),
        model: model.id,
        ...(requested ? { effort: requested } : {}),
        ...(context.systemPrompt ? { systemPrompt: context.systemPrompt } : {}),
        ...(conversationId ? { sessionId: conversationId } : {}),
      }, new Set(tools.map((tool) => tool.name)));
      await proc.prepare(options?.signal);
      check();
      if (!proc.isRunning) throw new Error("ACP exited before input delivery");
      if (!liveSession.setSession(proc, syncKey, bridge, proc.session.id, preparationId)) {
        throw new Error("ACP preparation superseded");
      }
      return { proc, mcpServer: bridge, modelId: model.id };
    } catch (error) {
      const failures: unknown[] = [];
      try { await bridge.close(); } catch (cleanupError) { failures.push(cleanupError); }
      try { await proc?.abort(); } catch (cleanupError) { failures.push(cleanupError); }
      if (failures.length) throw new AggregateError([error, ...failures], "ACP preparation and cleanup failed");
      throw error;
    } finally {
      options?.signal?.removeEventListener("abort", cancel);
    }
  };

  if (decision.action === "resume") {
    try {
      return { ...await startRuntime(decision.conversationId), reconstructContext: false };
    } catch (error) {
      check();
      await dependencies.store.delete(liveSession.piSessionId).catch((storeError) => {
        debugLog("session", "Failed to clear invalid ACP checkpoint:", storeError);
      });
      check();
      liveSession.resources.disposeAll();
    }
  }

  return { ...await startRuntime(), reconstructContext: true };
}
