import type { SessionNotification, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { PromptResponse, Usage } from "@agentclientprotocol/sdk/unstable";
import type { RuntimeEvent } from "../types.ts";
import { isRegisteredPiMcpTool, PI_MCP_SERVER } from "../mcp-identity.ts";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function mapUsage(raw: Usage | null | undefined): Extract<RuntimeEvent, { type: "accounting" }>["usage"] | undefined {
  if (!raw) return undefined;

  const inputTokens = tokenCount(raw.inputTokens);
  const outputTokens = tokenCount(raw.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;

  const cacheRead = tokenCount(raw.cachedReadTokens) ?? 0;
  const cacheWrite = tokenCount(raw.cachedWriteTokens) ?? 0;
  const reasoning = tokenCount(raw.thoughtTokens);
  const total = tokenCount(raw.totalTokens);
  const cache = cacheRead + cacheWrite;
  const inclusive = total === inputTokens + outputTokens ||
    reasoning !== undefined && total === inputTokens + outputTokens + reasoning;
  const exclusive = !inclusive && cache > 0 && (total === inputTokens + cache + outputTokens ||
    reasoning !== undefined && total === inputTokens + cache + outputTokens + reasoning);
  // Accept exclusive cache accounting only when the reported total proves it.
  const separateThought = reasoning !== undefined &&
    total === inputTokens + (exclusive ? cache : 0) + outputTokens + reasoning;
  const input = exclusive ? inputTokens : Math.max(0, inputTokens - cache);
  const output = outputTokens + (separateThought ? reasoning : 0);

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(reasoning !== undefined ? { reasoning } : {}),
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function isClientViewFile(call: ToolCallUpdate): boolean {
  return call.title?.trim().toLowerCase() === "running client_view_file" &&
    call.kind === "read" && call._meta?.mcp === undefined;
}

function getLazyMcpCall(call: ToolCallUpdate): { server: string; tool: string; args: unknown } | undefined {
  const name = call.name === "call_mcp_tool" ? call.name : call.title?.trim().replace(/^running\s+/i, "");
  if (name !== "call_mcp_tool" || !record(call.rawInput)) return undefined;

  const { ServerName: server, ToolName: tool } = call.rawInput;
  if (typeof server !== "string" || !server || typeof tool !== "string" || !tool) return undefined;

  return { server, tool, args: "Arguments" in call.rawInput ? call.rawInput.Arguments : call.rawInput };
}

type ObservedCall = { call: ToolCallUpdate; warned?: boolean };

export class EventProcessor {
  private readonly calls = new Map<string, ObservedCall>();
  private overflowWarned = false;
  private contextUsage: Extract<RuntimeEvent, { type: "usage" }>["usage"] | undefined;

  private readonly sessionId: string;
  private readonly allowedToolNames: ReadonlySet<string>;

  constructor(sessionId: string, allowedToolNames: ReadonlySet<string> = new Set()) {
    this.sessionId = sessionId;
    this.allowedToolNames = new Set(allowedToolNames);
  }

  process(notification: SessionNotification, source: "live" | "replay", emit: (event: RuntimeEvent) => void): void {
    if (source === "replay" || notification.sessionId !== this.sessionId) return;

    const update = notification.update;
    if (update.sessionUpdate === "usage_update") {
      const used = tokenCount(update.used);
      if (used === undefined) return;

      // Context updates are not billable input. The prompt response supplies
      // accounting once, even when MCP suspends the prompt across Pi messages.
      this.contextUsage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: used,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      emit({ type: "usage", usage: this.contextUsage });
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const id = update.toolCallId;
      if (!this.calls.has(id) && this.calls.size >= 1024) {
        if (!this.overflowWarned) {
          this.overflowWarned = true;
          emit({ type: "tool-warning", name: "unknown tool", args: undefined, status: "unknown", reason: "notification-limit" });
        }
        return;
      }
      const prior = this.calls.get(id);
      if (prior?.warned) return;
      const before = prior?.call._meta?.mcp;
      const after = update._meta?.mcp;
      if (record(before) && record(after) && ["server", "tool"].some((key) =>
        before[key] !== undefined && after[key] !== undefined && before[key] !== after[key])) {
        this.warn({ ...prior!.call, ...update, status: update.status ?? prior!.call.status ?? null, _meta: { ...prior!.call._meta, ...update._meta, mcp: { ...before, ...after } } }, emit);
        return;
      }
      // ACP v1 null fields leave prior values unchanged; rawInput replaces the whole value.
      const call: ToolCallUpdate = {
        ...prior?.call, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== null)), toolCallId: id,
      };
      if (prior?.call._meta) call._meta = { ...prior.call._meta, ...update._meta };
      // Malformed increments must not erase an established identity before a later conflict.
      if (record(before)) call._meta = { ...call._meta, mcp: record(after) ? { ...before, ...after } : before };
      this.calls.set(id, { call });
      this.check(id, emit, update.status === "completed" || update.status === "failed");
    } else if ((update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") && update.content.type === "text") {
      emit({ type: "session-reference", reference: this.sessionId });
      if (update.content.text.length > 0) {
        emit({ type: update.sessionUpdate === "agent_thought_chunk" ? "thinking-delta" : "text-delta", delta: update.content.text });
      }
    }
  }

  private check(id: string, emit: (event: RuntimeEvent) => void, final: boolean): void {
    const entry = this.calls.get(id);
    if (!entry || entry.warned) return;

    const { call } = entry;
    const mcp = call._meta?.mcp;
    if (isRegisteredPiMcpTool(mcp, this.allowedToolNames)) return;

    if (record(mcp) && (typeof mcp.server === "string" && mcp.server !== PI_MCP_SERVER ||
      typeof mcp.server === "string" && typeof mcp.tool === "string")) {
      this.warn(call, emit);
      return;
    }

    const lazy = getLazyMcpCall(call);
    if (lazy) {
      if (isRegisteredPiMcpTool(lazy, this.allowedToolNames)) return;
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
    const lazy = getLazyMcpCall(call);
    const name = record(mcp) && typeof mcp.tool === "string"
      ? mcp.tool : lazy?.tool ?? (call.name?.trim() || "unknown tool");
    const args = record(mcp) && record(call.rawInput) && record(call.rawInput.arguments)
      ? call.rawInput.arguments : lazy ? lazy.args : call.rawInput;

    emit({ type: "tool-warning", name, args, status: call.status ?? "unknown" });
  }

  complete(
    response: PromptResponse,
    emit: (event: RuntimeEvent) => void,
    lastCallUsage?: Extract<RuntimeEvent, { type: "accounting" }>["usage"],
  ): void {
    for (const id of this.calls.keys()) this.check(id, emit, true);
    this.calls.clear();
    this.overflowWarned = false;

    // MCP handoffs can replace the Pi writer during a single native prompt.
    // Give the final writer the latest context independently of accounting.
    const contextUsage = this.contextUsage;
    this.contextUsage = undefined;
    if (contextUsage) emit({ type: "usage", usage: contextUsage });

    const usage = mapUsage(response.usage);
    if (usage) emit({ type: "accounting", usage, ...(lastCallUsage ? { lastCallUsage } : {}) });

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
