import os from "node:os";
import path from "node:path";
import type { SessionNotification, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { PromptResponse, Usage } from "@agentclientprotocol/sdk/unstable";
import type { RuntimeEvent } from "../types.ts";
import { expandHome } from "../../shared/paths.ts";
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
  const separateThought = reasoning !== undefined &&
    tokenCount(raw.totalTokens) === inputTokens + cacheRead + cacheWrite + outputTokens + reasoning;
  // CLI reports uncached input separately from cache reads and writes.
  const input = inputTokens;
  const output = outputTokens + (separateThought ? reasoning : 0);

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(reasoning !== undefined ? { reasoning } : {}),
    totalTokens: tokenCount(raw.totalTokens) ?? input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function isAllowedNativeTool(call: ToolCallUpdate, sessionId: string): boolean {
  const name = call.title ?? call.name ?? call.kind;
  if (typeof name !== "string") return false;

  const normalized = name.trim().toLowerCase();
  const nativeTitle = normalized === "read_file" || normalized === "running read_file";

  // CLI replaces read_file's tool title with the artifact's display path.
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || call._meta?.mcp !== undefined ||
    call.name != null && call.name !== "read_file" || call.kind != null && call.kind !== "read" ||
    !record(call.rawInput) || typeof call.rawInput.Path !== "string" ||
    "ServerName" in call.rawInput || "ToolName" in call.rawInput) return false;

  const target = call.rawInput.Path;
  if (!path.isAbsolute(target) || target.includes("\0") || path.resolve(target) !== target) return false;

  const home = expandHome(process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini"));
  const root = path.resolve(home, "antigravity-cli");
  const steps = path.join(root, "brain", sessionId, ".system_generated", "steps");
  const relative = path.relative(steps, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;

  return nativeTitle || call.title === `File ${path.relative(root, target)}`;
}

function getMcpCall(call: ToolCallUpdate): { server: string; tool: string; args: unknown; displayTool: string | undefined } | undefined {
  if (!record(call.rawInput)) return undefined;

  const { ServerName: server, ToolName: tool } = call.rawInput;
  if (typeof server !== "string" || !server || typeof tool !== "string" || !tool) return undefined;

  const title = call.title?.trim().replace(/^running\s+/i, "");
  const displayTool = title?.startsWith("MCP Tool ") ? title.slice("MCP Tool ".length) : undefined;
  if (call.name !== "call_mcp_tool" && title !== "call_mcp_tool" && displayTool === undefined) return undefined;

  return { server, tool, args: "Arguments" in call.rawInput ? call.rawInput.Arguments : call.rawInput, displayTool };
}

type ObservedCall = {
  call: ToolCallUpdate;
  // Keep the first identity even when a replacement snapshot is incomplete.
  identity: { server: string; tool: string } | undefined;
  warned?: boolean;
};

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
      // ACP null fields preserve prior values; rawInput is a replacement snapshot.
      const call: ToolCallUpdate = {
        ...prior?.call, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== null)), toolCallId: id,
      };
      if (prior?.call._meta) call._meta = { ...prior.call._meta, ...update._meta };
      if (record(before)) call._meta = { ...call._meta, mcp: record(after) ? { ...before, ...after } : before };
      const currentMcp = getMcpCall(call) ??
        (isRegisteredPiMcpTool(call._meta?.mcp, this.allowedToolNames) ? call._meta.mcp : undefined);
      const identity = prior?.identity ?? (currentMcp && { server: currentMcp.server, tool: currentMcp.tool });
      this.calls.set(id, { call, identity });
      if (identity && currentMcp && (identity.server !== currentMcp.server || identity.tool !== currentMcp.tool)) {
        this.warn(call, emit);
        return;
      }
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
    if (record(mcp) && !isRegisteredPiMcpTool(mcp, this.allowedToolNames) &&
      (typeof mcp.server === "string" && mcp.server !== PI_MCP_SERVER ||
        typeof mcp.server === "string" && typeof mcp.tool === "string")) {
      this.warn(call, emit);
      return;
    }

    const wrapped = getMcpCall(call);
    if (wrapped) {
      if (!isRegisteredPiMcpTool(wrapped, this.allowedToolNames) ||
        wrapped.displayTool !== undefined && wrapped.displayTool !== wrapped.tool ||
        record(mcp) && (mcp.server !== undefined && mcp.server !== wrapped.server ||
          mcp.tool !== undefined && mcp.tool !== wrapped.tool)) {
        this.warn(call, emit);
      }
      return;
    }

    if (isRegisteredPiMcpTool(mcp, this.allowedToolNames)) return;
    if (isAllowedNativeTool(call, this.sessionId)) return;
    if (final && (call.title !== undefined || call.kind !== undefined || call.rawInput !== undefined || call._meta !== undefined || call.name !== undefined)) {
      this.warn(call, emit);
    }
  }

  private warn(call: ToolCallUpdate, emit: (event: RuntimeEvent) => void): void {
    const entry = this.calls.get(call.toolCallId);
    if (entry?.warned) return;
    if (entry) entry.warned = true;

    const mcp = call._meta?.mcp;
    const wrapped = getMcpCall(call);
    const name = record(mcp) && typeof mcp.tool === "string"
      ? mcp.tool : wrapped?.tool ?? (call.name?.trim() || "unknown tool");
    const args = record(mcp) && record(call.rawInput) && record(call.rawInput.arguments)
      ? call.rawInput.arguments : wrapped ? wrapped.args : call.rawInput;
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
