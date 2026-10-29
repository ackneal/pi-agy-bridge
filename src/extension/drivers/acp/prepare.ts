import type { Context, Model, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import { BridgeIPC } from "../../bridge/ipc.ts";
import { createMcpLaunchDescriptor } from "../../bridge/mcp-launch.ts";
import { calculateSyncKey, type LiveSession } from "../../session/session.ts";
import type { RuntimeSessionStore, RuntimeSessionSync } from "../../session/state.ts";
import type { AcpConnectionOptions } from "./connection.ts";
import { resolveAcpEffort } from "./options.ts";
import { debugLog } from "../../shared/debug.ts";
import { AcpRuntimeSession } from "./runtime.ts";
import { composeAcpSystemPrompt, fingerprintAcpSystemPrompt } from "./instructions.ts";

class AcpPreparationCleanupError extends AggregateError {}

export async function prepareAcpRuntime(
  model: Model<any>, context: Context, tools: readonly Tool[], options: SimpleStreamOptions | undefined,
  connection: { cwd: string; resolve: () => Promise<AcpConnectionOptions> },
  dependencies: { store: Pick<RuntimeSessionStore, "get" | "delete">; sync: Pick<RuntimeSessionSync, "decide">; sessionVersion: string },
  liveSession: LiveSession, preparationId: symbol,
): Promise<{ proc: AcpRuntimeSession; mcpServer: BridgeIPC; reconstructContext: boolean; modelId: string }> {
  const check = () => {
    options?.signal?.throwIfAborted();
    if (!liveSession.ownsPreparation(preparationId)) throw new Error("ACP preparation superseded");
  };
  check();
  const requested = resolveAcpEffort(model, options);
  const systemPrompt = composeAcpSystemPrompt(context);
  const compatibilityKey = fingerprintAcpSystemPrompt(JSON.stringify([connection.cwd, systemPrompt]));
  const syncKey = calculateSyncKey(systemPrompt, tools.map((tool) => JSON.stringify(tool)), model.id, requested, "acp");
  let resolvedConnection: AcpConnectionOptions | undefined;
  if (liveSession.driverId !== undefined && liveSession.driverId !== "acp") {
    resolvedConnection = await connection.resolve();
    check();
    await liveSession.dispose({ preparationId });
    check();
  }
  const checkpoint = await dependencies.store.get(liveSession.piSessionId, dependencies.sessionVersion);
  check();
  const latest = [...context.messages].reverse().find((message) => message.role === "assistant");
  const decision = dependencies.sync.decide(liveSession, {
    syncKey, compatibilityKey, messages: context.messages,
    ...(latest?.responseId ? { conversationId: latest.responseId } : {}),
    ...(checkpoint ? { checkpoint } : {}),
  });
  if (decision.action === "continue" && liveSession.activeProcess instanceof AcpRuntimeSession && liveSession.activeMcpServer) {
    const proc = liveSession.activeProcess;
    const matches = proc.options.model === model.id && proc.options.effort === requested;
    return { proc, mcpServer: liveSession.activeMcpServer, reconstructContext: false, modelId: matches ? model.id : latest?.model ?? proc.options.model };
  }
  resolvedConnection ??= await connection.resolve();
  check();

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
        ...resolvedConnection,
        cwd: connection.cwd,
        mcp: createMcpLaunchDescriptor(bridge.bridgeUri),
        model: model.id,
        ...(requested ? { effort: requested } : {}),
        systemPrompt,
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
      if (failures.length) throw new AcpPreparationCleanupError([error, ...failures], "ACP preparation and cleanup failed");
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
      if (error instanceof AcpPreparationCleanupError) throw error;
      await dependencies.store.delete(liveSession.piSessionId).catch((storeError) => {
        debugLog("session", "Failed to clear invalid ACP checkpoint:", storeError);
      });
      check();
      liveSession.resources.disposeAll();
    }
  }

  return { ...await startRuntime(), reconstructContext: true };
}
