import type { SessionNotification, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { PromptResponse, Usage } from "@agentclientprotocol/sdk/unstable";
import type { RuntimeEvent } from "../types.ts";

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
  const separateThought = reasoning !== undefined &&
    tokenCount(raw.totalTokens) === inputTokens + outputTokens + reasoning;
  const input = Math.max(0, inputTokens - cacheRead - cacheWrite);
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

function isAllowedNativeTool(call: ToolCallUpdate): boolean {
  const name = call.title ?? call.name ?? call.kind;
  if (typeof name !== "string") return false;

  const normalized = name.trim().toLowerCase();
  return normalized === "view_file" || normalized === "running view_file";
}

function isRegisteredPiMcpTool(mcp: unknown, allowedToolNames: ReadonlySet<string>): boolean {
  return record(mcp) && mcp.server === "pi-agy-bridge_pi" && typeof mcp.tool === "string" && allowedToolNames.has(mcp.tool);
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
      if (record(before)) call._meta = { ...call._meta, mcp: record(after) ? { ...before, ...after } : before };
      if (record(prior?.call.rawInput) && record(update.rawInput)) call.rawInput = { ...prior.call.rawInput, ...update.rawInput };
      this.calls.set(id, { call });
      this.check(id, emit, update.status === "completed" || update.status === "failed");
    } else if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      emit({ type: "session-reference", reference: this.sessionId });
      if (update.content.text.length > 0) emit({ type: "text-delta", delta: update.content.text });
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
    if (isAllowedNativeTool(call)) return;
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
      ? mcp.tool : (call.title ?? call.name ?? call.kind ?? "unverified tool").replace(/^Running /, "");
    const args = record(mcp) && record(call.rawInput) && record(call.rawInput.arguments)
      ? call.rawInput.arguments : call.rawInput;
    emit({ type: "tool-warning", name, args });
  }

  complete(response: PromptResponse, emit: (event: RuntimeEvent) => void): void {
    for (const id of this.calls.keys()) this.check(id, emit, true);
    this.calls.clear();
    this.overflowWarned = false;

    const contextUsage = this.contextUsage;
    this.contextUsage = undefined;
    if (contextUsage) emit({ type: "usage", usage: contextUsage });

    const usage = mapUsage(response.usage);
    if (usage) emit({ type: "accounting", usage });

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
