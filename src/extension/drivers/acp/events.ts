import type { PromptResponse, SessionNotification } from "@agentclientprotocol/sdk";
import type { RuntimeEvent } from "../types.ts";

export class AcpEventTranslator {
  private readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  translate(notification: SessionNotification, source: "live" | "replay", emit: (event: RuntimeEvent) => void): void {
    if (source === "replay" || notification.sessionId !== this.sessionId) return;

    const update = notification.update;
    // Only explicit execution/mutation kinds are unambiguous here. Missing MCP
    // metadata and display titles do not establish native tool identity.
    if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
      (update.kind === "execute" || update.kind === "edit" || update.kind === "delete" || update.kind === "move")) {
      emit({ type: "blocked-native-tool", name: update.title || update.kind });
    } else if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      emit({ type: "session-reference", reference: this.sessionId });
      if (update.content.text.length > 0) emit({ type: "text-delta", delta: update.content.text });
    } else if (update.sessionUpdate === "usage_update" && Number.isFinite(update.used) && update.used >= 0) {
      // Context occupancy is not input/output billing, account quota, or window capacity.
      emit({ type: "usage", usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: update.used,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      } });
    }
  }

  complete(response: PromptResponse, emit: (event: RuntimeEvent) => void): void {
    emit({ type: "session-reference", reference: this.sessionId });
    switch (response.stopReason) {
      case "end_turn":
        emit({ type: "complete", reason: "stop", resumable: true });
        break;
      case "cancelled":
        emit({ type: "complete", reason: "aborted", resumable: false });
        break;
      default:
        emit({ type: "complete", reason: "error", error: `ACP prompt stopped: ${response.stopReason}`, resumable: false });
    }
  }
}

