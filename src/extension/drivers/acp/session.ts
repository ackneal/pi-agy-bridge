import * as acp from "@agentclientprotocol/sdk";
import type { McpLaunchDescriptor } from "../../bridge/mcp-launch.ts";
import { AcpConnection, type AcpConnectionOptions } from "./connection.ts";

export interface AcpSessionOptions extends Omit<AcpConnectionOptions, "onUpdate" | "onPermission"> {
  mcp: McpLaunchDescriptor;
  model: string;
  effort?: string;
  sessionId?: string;
  systemPrompt?: string;
  onUpdate: (notification: acp.SessionNotification) => void | Promise<void>;
  onPermission?: AcpConnectionOptions["onPermission"];
}

/** Owns one native prompt across any number of Pi tool handoffs. */
export class AcpSession {
  private readonly connection: AcpConnection;
  private readonly options: AcpSessionOptions;
  private sessionId: string | undefined;
  private preparing = true;
  private preparation: Promise<void> | undefined;
  private activePrompt: Promise<acp.PromptResponse> | undefined;
  private configOptions: acp.SessionConfigOption[] = [];

  constructor(options: AcpSessionOptions) {
    this.options = options;
    this.connection = new AcpConnection({
      ...options,
      onPermission: (request) => {
        if (!this.preparing && request.sessionId === this.sessionId && options.onPermission) {
          return options.onPermission(request);
        }
        return { outcome: { outcome: "cancelled" } };
      },
      onUpdate: (notification) => {
        // session/load replays history before its response. It is not new output.
        if (!this.preparing && notification.sessionId === this.sessionId) {
          return options.onUpdate(notification);
        }
      },
    });
  }

  get id(): string {
    if (!this.sessionId) throw new Error("ACP session is not prepared");
    return this.sessionId;
  }

  get isRunning(): boolean { return !this.preparing && this.connection.isRunning; }
  get hasActivePrompt(): boolean { return this.activePrompt !== undefined; }

  prepare(signal?: AbortSignal): Promise<void> {
    this.preparation ??= this.prepareSession(signal);
    return this.preparation;
  }

  private async prepareSession(signal?: AbortSignal): Promise<void> {
    const abort = () => { void this.connection.dispose(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      const initialized = await this.connection.start(signal);
      signal?.throwIfAborted();
      if (this.options.systemPrompt !== undefined) {
        const antigravity = initialized.agentCapabilities?._meta?.antigravity;
        if (!antigravity || typeof antigravity !== "object" || !("systemPrompt" in antigravity) ||
          !antigravity.systemPrompt || typeof antigravity.systemPrompt !== "object" ||
          !("append" in antigravity.systemPrompt) || antigravity.systemPrompt.append !== true) {
          throw new Error("ACP server must advertise agentCapabilities._meta.antigravity.systemPrompt.append === true to deliver system instructions");
        }
      }
      const params: acp.NewSessionRequest = {
        cwd: this.options.cwd,
        mcpServers: [{ name: "pi-agy-bridge_pi", command: this.options.mcp.command, args: this.options.mcp.args, env: [] }],
        _meta: { antigravity: {
          enabledTools: [],
          ...(this.options.systemPrompt !== undefined ? { systemPrompt: { append: this.options.systemPrompt } } : {}),
        } },
      };
      if (this.options.sessionId) {
        if (!initialized.agentCapabilities?.loadSession) throw new Error("ACP server does not support session loading");
        const loaded = await this.connection.request(acp.methods.agent.session.load, { ...params, sessionId: this.options.sessionId });
        this.sessionId = this.options.sessionId;
        this.configOptions = loaded.configOptions ?? [];
      } else {
        const created = await this.connection.request(acp.methods.agent.session.new, params);
        if (!created.sessionId.trim()) throw new Error("ACP server returned an empty session ID");
        this.sessionId = created.sessionId;
        this.configOptions = created.configOptions ?? [];
      }
      signal?.throwIfAborted();
      await this.applyConfiguration("mode", "default");
      signal?.throwIfAborted();
      await this.applyConfiguration("model", this.options.model);
      signal?.throwIfAborted();
      if (this.options.effort !== undefined) await this.applyConfiguration("thinking_level", this.options.effort);
      signal?.throwIfAborted();
      this.verifyConfiguration("mode", "default");
      this.verifyConfiguration("model", this.options.model);
      if (this.options.effort !== undefined) this.verifyConfiguration("thinking_level", this.options.effort);
      this.preparing = false;
    } catch (error) {
      try {
        await this.dispose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `ACP session preparation failed: ${error instanceof Error ? error.message : String(error)}; cleanup failed`);
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private async applyConfiguration(id: string, value: string): Promise<void> {
    const option = this.configOptions.find((entry) => entry.id === id);
    if (!option || option.type !== "select") throw new Error(`ACP required configuration is unavailable: ${id}`);
    const values = option.options.flatMap((entry) => "group" in entry ? entry.options : [entry]);
    if (!values.some((entry) => entry.value === value)) throw new Error(`ACP unsupported ${id}: ${value}`);

    // Load can reset settings. Always apply and verify the requested value.
    const response = await this.connection.request(acp.methods.agent.session.setConfigOption, { sessionId: this.id, configId: id, value });
    this.configOptions = response.configOptions;
    this.verifyConfiguration(id, value);
  }

  private verifyConfiguration(id: string, value: string): void {
    if (this.configOptions.find((entry) => entry.id === id)?.currentValue !== value) {
      throw new Error(`ACP did not apply the requested ${id}: ${value}`);
    }
  }

  prompt(content: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    if (!this.isRunning) return Promise.reject(new Error("ACP session is not running"));
    if (this.activePrompt) return Promise.reject(new Error("ACP session already has an active prompt"));
    if (content.length === 0) return Promise.reject(new Error("ACP prompt must not be empty"));

    const request = this.connection.request(acp.methods.agent.session.prompt, { sessionId: this.id, prompt: content });
    const pending = request.finally(() => {
      if (this.activePrompt === pending) this.activePrompt = undefined;
    });
    this.activePrompt = pending;
    return pending;
  }

  async cancel(): Promise<void> {
    // Cancellation invalidates this connection; never revive unresolved MCP state.
    try {
      if (this.connection.isRunning && this.sessionId) {
        await this.connection.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId });
      }
    } finally {
      await this.dispose();
    }
  }

  dispose(): Promise<void> { return this.connection.dispose(); }
}
