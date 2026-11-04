import type { SessionNotification, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { PromptResponse, Usage } from "@agentclientprotocol/sdk/unstable";
import type { RuntimeEvent } from "../types.ts";
import { PI_MCP_SERVER } from "./permissions.ts";

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
  // AGY includes cache tokens in inputTokens. Add thoughts to output only
  // when the accounting total proves they were reported separately.
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

function isClientViewFile(call: ToolCallUpdate): boolean {
  return call.title?.trim().toLowerCase() === "running client_view_file" &&
    call.kind === "read" && call._meta?.mcp === undefined;
}

type McpIdentity = { server?: string; tool?: string };

function lazyTool(call: ToolCallUpdate): boolean {
  const name = call.name === "call_mcp_tool" ? call.name : call.title?.trim().replace(/^running\s+/i, "");
  return name?.trim() === "call_mcp_tool";
}

function mcpIdentity(value: unknown): McpIdentity | undefined {
  if (!record(value)) return undefined;
  const server = typeof value.server === "string" ? value.server : undefined;
  const tool = typeof value.tool === "string" ? value.tool : undefined;
  return server !== undefined || tool !== undefined ? { server, tool } : undefined;
}

function lazyIdentity(value: unknown): McpIdentity | undefined {
  if (!record(value)) return undefined;
  const server = typeof value.ServerName === "string" ? value.ServerName : undefined;
  const tool = typeof value.ToolName === "string" ? value.ToolName : undefined;
  return server !== undefined || tool !== undefined ? { server, tool } : undefined;
}

function conflicts(a?: McpIdentity, b?: McpIdentity): boolean {
  return !!(a && b && (a.server !== undefined && b.server !== undefined && a.server !== b.server ||
    a.tool !== undefined && b.tool !== undefined && a.tool !== b.tool));
}

function identity(call: ToolCallUpdate): { value?: McpIdentity; conflict: boolean } {
  const standard = mcpIdentity(call._meta?.mcp);
  const lazy = lazyTool(call) ? lazyIdentity(call.rawInput) : undefined;
  return {
    conflict: conflicts(standard, lazy),
    value: standard || lazy ? { server: standard?.server ?? lazy?.server, tool: standard?.tool ?? lazy?.tool } : undefined,
  };
}

function validateMcpIdentity(value: McpIdentity | undefined, allowed: ReadonlySet<string>): "allowed" | "rejected" | "incomplete" {
  if (!value) return "incomplete";
  if (value.server !== undefined && value.server !== PI_MCP_SERVER) return "rejected";
  if (value.tool !== undefined && !allowed.has(value.tool)) return "rejected";
  return value.server !== undefined && value.tool !== undefined ? "allowed" : "incomplete";
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
          this.warn({ toolCallId: id, title: "ACP tool notification limit exceeded" }, emit);
        }
        return;
      }
      const prior = this.calls.get(id);
      if (prior?.warned) return;
      const before = prior?.call._meta?.mcp;
      const after = update._meta?.mcp;
      const previousIdentity = prior ? identity(prior.call).value : undefined;
      const incomingStandard = mcpIdentity(after);
      const incomingLazy = lazyTool({ ...prior?.call, ...update }) ? lazyIdentity(update.rawInput) : undefined;
      const call = { ...prior?.call, ...update };
      for (const key of ["name", "title"] as const) {
        if (call[key] === undefined || call[key] === null || call[key] === "") call[key] = prior?.call[key];
      }
      if (prior?.call._meta) call._meta = { ...prior.call._meta, ...update._meta };
      if (record(before)) call._meta = { ...call._meta, mcp: record(after)
        ? { ...before, ...Object.fromEntries(Object.entries(after).filter(([, value]) => value !== undefined)) } : before };
      if (record(prior?.call.rawInput)) {
        call.rawInput = record(update.rawInput)
          ? { ...prior.call.rawInput, ...Object.fromEntries(Object.entries(update.rawInput).filter(([, value]) => value !== undefined)) }
          : prior.call.rawInput;
      }
      this.calls.set(id, { ...prior, call });
      if (conflicts(previousIdentity, incomingStandard) || conflicts(previousIdentity, incomingLazy) ||
        conflicts(incomingStandard, incomingLazy) || identity(call).conflict) {
        this.warn(call, emit);
      } else {
        this.check(id, emit, update.status === "completed" || update.status === "failed");
      }
    } else if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      emit({ type: "session-reference", reference: this.sessionId });
      if (update.content.text.length > 0) emit({ type: "text-delta", delta: update.content.text });
    }
  }

  private check(id: string, emit: (event: RuntimeEvent) => void, final: boolean): void {
    const entry = this.calls.get(id);
    if (!entry || entry.warned) return;

    const { call } = entry;
    const parsed = identity(call);
    const decision = validateMcpIdentity(parsed.value, this.allowedToolNames);
    if (parsed.conflict || decision === "rejected") {
      this.warn(call, emit);
      return;
    }
    if (decision === "allowed") return;

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

    const parsed = identity(call).value;
    const name = parsed?.tool ?? (call.title ?? call.name ?? call.kind ?? "unverified ACP tool").replace(/^Running /, "");
    const raw = call.rawInput;
    const args = record(raw) && lazyTool(call) && "Arguments" in raw ? raw.Arguments
      : record(raw) && record(raw.arguments) ? raw.arguments : raw;

    emit({ type: "tool-warning", name, args });
  }

  complete(response: PromptResponse, emit: (event: RuntimeEvent) => void): void {
    for (const id of this.calls.keys()) this.check(id, emit, true);
    this.calls.clear();
    this.overflowWarned = false;

    // MCP handoffs can replace the Pi writer during a single native prompt.
    // Give the final writer the latest context independently of accounting.
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
