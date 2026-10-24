import { isDeepStrictEqual } from "node:util";
import type { RequestPermissionRequest, RequestPermissionResponse, SessionNotification, ToolCallUpdate } from "@agentclientprotocol/sdk";

const SERVER = "pi-agy-bridge_pi";
const LIMIT = 1024;

/** Permits only MCP transport; the Pi gateway still owns execution and policy.
 * Callers must not feed replay notifications into this gate.
 */
export class AcpMcpPermissions {
  private readonly calls = new Map<string, ToolCallUpdate | null>();
  private overflow = false;

  private readonly sessionId: string;
  private readonly allowedToolNames: ReadonlySet<string>;

  constructor(sessionId: string, allowedToolNames: ReadonlySet<string>) {
    this.sessionId = sessionId;
    this.allowedToolNames = new Set(allowedToolNames);
  }

  observe(notification: SessionNotification): void {
    if (notification.sessionId !== this.sessionId || this.overflow) return;
    const update = notification.update;
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
    const id = update.toolCallId;
    if (!this.calls.has(id) && this.calls.size >= LIMIT) {
      this.calls.clear();
      this.overflow = true;
      return;
    }
    const prior = this.calls.get(id);
    if (prior === null) return;
    const merged = this.merge(prior, update);
    this.calls.set(id, merged === null ? null : structuredClone(merged));
  }

  reply(request: RequestPermissionRequest): RequestPermissionResponse {
    const cancelled: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
    if (request.sessionId !== this.sessionId || this.overflow) return cancelled;
    const id = request.toolCall.toolCallId;
    const prior = this.calls.get(id);
    // Retain a tombstone so duplicate announcements cannot re-arm a consumed ID.
    this.calls.set(id, null);
    if (!prior || !this.complete(prior) || !record(request.toolCall.rawInput)) return cancelled;
    const current = this.merge(prior, request.toolCall);
    if (!current || !this.complete(current) || !isDeepStrictEqual(prior.rawInput, request.toolCall.rawInput)) return cancelled;
    const option = request.options.find((item) => item.kind === "allow_once");
    return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : cancelled;
  }

  reset(): void {
    this.calls.clear();
    this.overflow = false;
  }

  private merge(prior: ToolCallUpdate | undefined, update: ToolCallUpdate): ToolCallUpdate | null {
    if (update.status === "completed" || update.status === "failed") return null;
    if (update.kind !== undefined && update.kind !== "other") return null;
    for (const key of ["title", "rawInput", "name"] as const) {
      if (prior?.[key] !== undefined && update[key] !== undefined && !isDeepStrictEqual(prior[key], update[key])) return null;
    }
    if (update._meta !== undefined) {
      const mcp = update._meta?.mcp;
      if (!record(mcp) || mcp.server !== SERVER || typeof mcp.tool !== "string" || !this.allowedToolNames.has(mcp.tool)) return null;
      if (prior?._meta !== undefined && !isDeepStrictEqual(prior._meta?.mcp, mcp)) return null;
    }
    if (update.rawInput !== undefined && (!record(update.rawInput) || !record(update.rawInput.arguments))) return null;
    const merged = { ...prior, ...update };
    const mcp = merged._meta?.mcp;
    if (merged.title !== undefined && (typeof merged.title !== "string" || (record(mcp) && merged.title !== `${SERVER}_${String(mcp.tool)}`))) return null;
    return merged;
  }

  private complete(call: ToolCallUpdate): boolean {
    const mcp = call._meta?.mcp;
    return record(mcp) && mcp.server === SERVER && typeof mcp.tool === "string" &&
      this.allowedToolNames.has(mcp.tool) && call.title === `${SERVER}_${mcp.tool}` &&
      record(call.rawInput) && record(call.rawInput.arguments);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
