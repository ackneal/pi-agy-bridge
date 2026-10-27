import type { PromptResponse, SessionNotification, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { RuntimeEvent } from "../types.ts";
import { isRegisteredPiMcpTool } from "./permissions.ts";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isClientViewFile(call: ToolCallUpdate): boolean {
  return call.title?.trim().toLowerCase() === "running client_view_file" &&
    call.kind === "read" && call._meta?.mcp === undefined;
}

type ObservedCall = { call: ToolCallUpdate; warned?: boolean };

export class EventProcessor {
  private readonly calls = new Map<string, ObservedCall>();
  private overflowWarned = false;

  private readonly sessionId: string;
  private readonly allowedToolNames: ReadonlySet<string>;

  constructor(sessionId: string, allowedToolNames: ReadonlySet<string> = new Set()) {
    this.sessionId = sessionId;
    this.allowedToolNames = new Set(allowedToolNames);
  }

  process(notification: SessionNotification, source: "live" | "replay", emit: (event: RuntimeEvent) => void): void {
    if (source === "replay" || notification.sessionId !== this.sessionId) return;

    const update = notification.update;
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const id = update.toolCallId;
      if (!this.calls.has(id) && this.calls.size >= 1024) {
        if (!this.overflowWarned) {
          this.overflowWarned = true;
          this.warn({ toolCallId: id, title: "ACP tool notification limit exceeded" }, emit);
        }
        return;
      }
      const prior = this.calls.get(id);
      if (prior?.warned) return;
      const before = prior?.call._meta?.mcp;
      const after = update._meta?.mcp;
      if (record(before) && record(after) && ["server", "tool"].some((key) =>
        before[key] !== undefined && after[key] !== undefined && before[key] !== after[key])) {
        this.warn({ ...prior!.call, ...update, _meta: { ...prior!.call._meta, ...update._meta, mcp: { ...before, ...after } } }, emit);
        return;
      }
      const call = { ...prior?.call, ...update };
      if (prior?.call._meta) call._meta = { ...prior.call._meta, ...update._meta };
      // Malformed increments must not erase an established identity before a later conflict.
      if (record(before)) call._meta = { ...call._meta, mcp: record(after) ? { ...before, ...after } : before };
      if (record(prior?.call.rawInput) && record(update.rawInput)) call.rawInput = { ...prior.call.rawInput, ...update.rawInput };
      this.calls.set(id, { call });
      this.check(id, emit, update.status === "completed" || update.status === "failed");
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

  private check(id: string, emit: (event: RuntimeEvent) => void, final: boolean): void {
    const entry = this.calls.get(id);
    if (!entry || entry.warned) return;
    const { call } = entry;
    const mcp = call._meta?.mcp;
    if (isRegisteredPiMcpTool(mcp, this.allowedToolNames)) return;
    if (record(mcp) && (typeof mcp.server === "string" && mcp.server !== "pi-agy-bridge_pi" ||
      typeof mcp.server === "string" && typeof mcp.tool === "string")) {
      this.warn(call, emit);
      return;
    }
    // Notifications describe activity; only the Artifact Reader authorizes client reads.
    // RPC ordering, read failures, and paths do not change this classification.
    if (isClientViewFile(call)) return;
    // Missing identity in an incremental update is not proof of a native call.
    // Require an allowlisted route once identifiable activity finishes.
    if (final && (call.title !== undefined || call.kind !== undefined || call.rawInput !== undefined || call._meta !== undefined || call.name !== undefined)) {
      this.warn(call, emit);
    }
  }

  private warn(call: ToolCallUpdate, emit: (event: RuntimeEvent) => void): void {
    const entry = this.calls.get(call.toolCallId);
    if (entry?.warned) return;
    if (entry) entry.warned = true;

    const mcp = call._meta?.mcp;
    const name = record(mcp) && typeof mcp.tool === "string"
      ? mcp.tool : (call.title ?? call.name ?? call.kind ?? "unverified ACP tool").replace(/^Running /, "");
    const args = record(mcp) && record(call.rawInput) && record(call.rawInput.arguments)
      ? call.rawInput.arguments : call.rawInput;
    emit({ type: "tool-warning", name, args });
  }

  complete(response: PromptResponse, emit: (event: RuntimeEvent) => void): void {
    for (const id of this.calls.keys()) this.check(id, emit, true);
    this.calls.clear();
    this.overflowWarned = false;

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
