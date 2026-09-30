import { randomUUID } from "node:crypto";
import type { JsonObject, Message, Tool, ToolCall } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { SessionResources } from "../session/session.ts";
import { debugLog } from "../shared/debug.ts";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

export const AGY_MCP_PREFIX = "mcp__pi__";

export function fromMcpToolName(mcpName: string): string {
  return mcpName.startsWith(AGY_MCP_PREFIX)
    ? mcpName.slice(AGY_MCP_PREFIX.length)
    : mcpName;
}

export function translateToolSchema(
  parameters?: TSchema | Record<string, unknown>
): McpToolDefinition["inputSchema"] {
  if (!parameters || typeof parameters !== "object") {
    return { type: "object", properties: {} };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  if (parsed["type"] !== "object") {
    return { type: "object", properties: {} };
  }

  return {
    ...parsed,
    type: "object",
    properties: isRecord(parsed["properties"]) ? parsed["properties"] : {},
  };
}

export function piToolToMcpTool(tool: Tool): McpToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: translateToolSchema(tool.parameters),
  };
}

export function isAllowedPiToolName(toolName: string, allowedToolNames: ReadonlySet<string>): boolean {
  return toolName.startsWith(AGY_MCP_PREFIX) && allowedToolNames.has(toolName);
}

export interface McpToolResult {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
}

export class PiToolAdapter {
  private readonly tools: Map<string, Tool>;
  private readonly resources: SessionResources | undefined;

  constructor(tools: readonly Tool[], resources?: SessionResources) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
    this.resources = resources;
  }

  public list(): ReturnType<typeof piToolToMcpTool>[] {
    return [...this.tools.values()].map(piToolToMcpTool);
  }

  public createCall(name: string, args: JsonObject): ToolCall | undefined {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    return {
      type: "toolCall",
      id: `pi_${randomUUID()}`,
      name: tool.name,
      arguments: tool.name === "pty" ? this.restoreTerminalHandles(args) as JsonObject : args,
    };
  }

  public toMcpResult(
    message: Extract<Message, { role: "toolResult" }>,
    call: ToolCall
  ): McpToolResult {
    const isPtyCall = call.name === "pty";
    const isPtyStart = isPtyCall && hasOperation(call.arguments, "start");
    if (isPtyCall) this.exposeTerminalHandles(message.details, isPtyStart);
    const content = message.content.map((block) => {
      if (block.type === "image") {
        return { type: "image" as const, data: block.data, mimeType: block.mimeType };
      }
      const text = isPtyCall ? this.exposeTextHandles(block.text, isPtyStart) : block.text;
      return { type: "text" as const, text };
    });

    if (isPtyStart && message.details === undefined) {
      for (const block of message.content) {
        if (block.type !== "text") continue;
        const parsed = parseJson(block.text);
        if (parsed !== undefined) this.exposeTerminalHandles(parsed, true);
      }
    }

    return { content, isError: message.isError };
  }

  private restoreTerminalHandles(value: unknown, fieldName = ""): unknown {
    if (typeof value === "string") {
      if (!isPtyIdField(fieldName)) return value;
      const resolved = this.resources?.terminals.resolve(value);
      if (!resolved) throw new Error(`Unknown terminal handle "${value}".`);
      return resolved;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.restoreTerminalHandles(item, fieldName));
    }
    if (!isRecord(value)) {
      if (fieldName && isPtyIdField(fieldName) && value !== undefined) {
        throw new Error(`Terminal identifier field "${fieldName}" must be a session handle.`);
      }
      return value;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, this.restoreTerminalHandles(item, key)]
    ));
  }

  private exposeTerminalHandles(value: unknown, bindNew: boolean): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.exposeTerminalHandles(item, bindNew));
    }
    if (!isRecord(value)) return value;

    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (typeof item === "string" && isPtyIdField(key)) {
        const handle = bindNew
          ? this.resources?.terminals.bind(item)
          : this.resources?.terminals.toHandle(item);
        return [key, handle ?? item];
      }
      return [key, this.exposeTerminalHandles(item, bindNew)];
    }));
  }

  private exposeTextHandles(text: string, bindNew: boolean): string {
    const parsed = parseJson(text);
    if (parsed !== undefined) {
      return JSON.stringify(this.exposeTerminalHandles(parsed, bindNew));
    }

    return text.replace(/[^\s"']+/g, (value) => this.resources?.terminals.toHandle(value) ?? value);
  }

}

function hasOperation(args: Record<string, unknown>, operation: string): boolean {
  return Object.values(args).some((value) => value === operation);
}

function isPtyIdField(key: string): boolean {
  return /^(?:pty|terminal)[_-]?id$/i.test(key);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface PiToolCallBatch {
  calls: ToolCall[];
  complete: () => void;
}

export class CapabilityGateway {
  private readonly piTools: PiToolAdapter;
  private readonly pending = new Map<string, {
    call: ToolCall;
    resolve: (result: McpToolResult) => void;
  }>();
  private queuedCalls: ToolCall[] = [];
  private dispatchTimer: NodeJS.Immediate | null = null;
  private onToolCalls: ((batch: PiToolCallBatch) => void) | null = null;

  constructor(tools: ConstructorParameters<typeof PiToolAdapter>[0], resources?: SessionResources) {
    this.piTools = new PiToolAdapter(tools, resources);
  }

  public get hasPendingCalls(): boolean {
    return this.pending.size > 0;
  }

  public list(): ReturnType<PiToolAdapter["list"]> {
    const tools = this.piTools.list();
    debugLog("mcp", "MCP tool list:", tools.map((tool) => tool.name));
    return tools;
  }

  public setToolCallHandler(handler: ((batch: PiToolCallBatch) => void) | null): void {
    this.onToolCalls = handler;
    this.dispatchQueuedCalls();
  }

  public call(name: string, args: JsonObject): Promise<McpToolResult> {
    let toolCall: ToolCall | undefined;
    try {
      toolCall = this.piTools.createCall(name, args);
    } catch (error) {
      return Promise.resolve(toolError(error instanceof Error ? error.message : String(error)));
    }
    if (!toolCall) {
      return Promise.resolve(toolError(`Tool "${name}" is not registered in this Pi session.`));
    }

    return new Promise((resolve) => {
      this.pending.set(toolCall.id, { call: toolCall, resolve });
      this.queuedCalls.push(toolCall);
      this.scheduleDispatch();
    });
  }

  public resolveToolResults(messages: readonly Message[]): number {
    let resolved = 0;
    for (const message of messages) {
      if (message.role !== "toolResult") continue;
      const pending = this.pending.get(message.toolCallId);
      if (!pending) continue;
      this.pending.delete(message.toolCallId);
      try {
        pending.resolve(this.piTools.toMcpResult(message, pending.call));
      } catch (error) {
        pending.resolve(toolError(error instanceof Error ? error.message : String(error)));
      }
      resolved++;
    }
    return resolved;
  }

  public cancelPendingCalls(message: string): void {
    if (this.dispatchTimer) {
      clearImmediate(this.dispatchTimer);
      this.dispatchTimer = null;
    }
    for (const pending of this.pending.values()) pending.resolve(toolError(message));
    this.pending.clear();
    this.queuedCalls = [];
  }

  private scheduleDispatch(): void {
    if (!this.onToolCalls || this.dispatchTimer) return;
    this.dispatchTimer = setImmediate(() => {
      this.dispatchTimer = null;
      this.dispatchQueuedCalls();
    });
  }

  private dispatchQueuedCalls(): void {
    if (!this.onToolCalls || this.queuedCalls.length === 0) return;
    const batch: PiToolCallBatch = {
      calls: this.queuedCalls.splice(0),
      complete: () => this.scheduleDispatch(),
    };

    try {
      this.onToolCalls(batch);
    } catch (error) {
      for (const call of batch.calls) {
        const pending = this.pending.get(call.id);
        if (!pending) continue;
        this.pending.delete(call.id);
        pending.resolve(toolError(error instanceof Error ? error.message : String(error)));
      }
    }
  }
}

function toolError(message: string): McpToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}
