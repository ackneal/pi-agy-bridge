import type { Context } from "@earendil-works/pi-ai";
import type { BridgeIPC } from "../bridge/bridge-ipc.ts";
import type { PiToolCallBatch } from "../bridge/capabilities.ts";
import type { PiEventAdapter } from "../runtime/events.ts";
import type { AgyEventSource, AgyRuntime } from "../runtime/process.ts";
import type { LiveSession } from "../session/session.ts";
import type { RuntimeSessionStore, RuntimeSessionSync } from "../session/session-state.ts";
import { debugArtifact, debugLog } from "../shared/debug.ts";
import type { AgyEvent, AgyInput } from "../shared/types.ts";

interface TurnOptions {
  session: LiveSession;
  adapter: PiEventAdapter;
  context: Context;
  sync: RuntimeSessionSync;
  store: RuntimeSessionStore;
  preparationId: symbol;
  signal: AbortSignal | undefined;
  loginEpoch: string | undefined;
}

export class AgyTurn {
  private runtime: { proc: AgyRuntime; mcpServer: BridgeIPC } | undefined;
  private completed = false;
  private sendingInput = false;
  private readonly options: TurnOptions;

  constructor(options: TurnOptions) {
    this.options = options;
  }

  public attach(runtime: { proc: AgyRuntime; mcpServer: BridgeIPC }): void {
    const { session, adapter, signal, preparationId } = this.options;
    if (!session.ownsPreparation(preparationId)) {
      throw new Error("Antigravity CLI runtime preparation was superseded");
    }
    this.runtime = runtime;
    signal?.throwIfAborted();
    if (!this.ownsRuntime()) {
      throw new Error("Antigravity CLI runtime was invalidated before input delivery");
    }

    session.releasePreparation(preparationId);
    runtime.mcpServer.setTransportFailureHandler((error) => this.failRuntime(error));
    if (adapter.isCompleted()) return;

    session.setRuntimeEventHandler((event, source) => this.handleEvent(event, source));
    session.setAbortSignal(signal, () => this.cancel("Request aborted by user"));
  }

  public openToolDispatch(): void {
    if (!this.ownsRuntime() || this.options.adapter.isCompleted()) return;

    this.runtime!.mcpServer.setToolCallHandler((batch) => this.handleToolCalls(batch));
  }

  public async recordAcceptedContext(): Promise<void> {
    if (!this.ownsRuntime()) return;

    const { session, context, sync } = this.options;
    sync.record(session, context.messages);
    await this.persist(context.messages);
  }

  public async send(input: AgyInput): Promise<void> {
    if (this.options.adapter.isCompleted()) return;
    if (!this.ownsRuntime()) throw new Error("Antigravity CLI runtime was invalidated before input delivery");
    this.options.signal?.throwIfAborted();

    this.sendingInput = true;
    await this.runtime!.proc.send(input);
  }

  public fail(error: unknown): void {
    const { adapter, signal, session, preparationId } = this.options;
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = signal?.aborted && !this.sendingInput;
    debugLog("register", "Turn execution failed:", message);

    if (cancelled) {
      this.cancel(message);
    } else {
      adapter.handleTermination("error", message);
      // Preparation cleans its local resources; it has not acquired this runtime.
      if (this.runtime) this.close("invalidate");
    }
    session.releasePreparation(preparationId);
  }

  private ownsRuntime(): boolean {
    const { session } = this.options;
    return this.runtime !== undefined && session.activeProcess === this.runtime.proc &&
      session.activeMcpServer === this.runtime.mcpServer;
  }

  private ownsSession(): boolean {
    return this.runtime ? this.ownsRuntime() : this.options.session.ownsPreparation(this.options.preparationId);
  }

  private handleEvent(event: AgyEvent, source: AgyEventSource): void {
    if (!this.ownsRuntime()) return;

    const { adapter } = this.options;
    const mcpServer = this.runtime!.mcpServer;
    if (adapter.isCompleted()) {
      // Pi may still be executing tools after its stream ends.
      const blockedTool = adapter.getBlockedToolName(event);
      if (source === "runtime" || (event.event === "result" && mcpServer.hasPendingCalls) || blockedTool !== undefined) {
        debugLog("session", "Invalidating runtime between Pi tool turns", { source, event: event.event, blockedTool });
        this.close("invalidate");
      }
      return;
    }

    try {
      adapter.handleEvent(event, source);
      this.complete(source === "agy" && event.event === "result" && !mcpServer.hasPendingCalls);
    } catch (error) {
      this.fail(error);
    }
  }

  private handleToolCalls(batch: PiToolCallBatch): void {
    try {
      if (!this.ownsRuntime()) return;

      this.options.adapter.handleBridgeToolCalls(batch.calls);
      this.complete();
    } catch (error) {
      this.fail(error);
    } finally {
      batch.complete();
    }
  }

  private complete(resumableError = false): void {
    const { adapter, session, context, sync } = this.options;
    if (!adapter.isCompleted() || this.completed || !this.ownsRuntime()) return;

    this.completed = true;
    const message = adapter.message;
    const hasPendingCalls = this.runtime!.mcpServer.hasPendingCalls;
    debugArtifact("assistant-message", { sessionId: session.piSessionId, message });
    if ((message.stopReason === "error" && !resumableError) ||
      (message.stopReason !== "toolUse" && hasPendingCalls)) {
      this.close("invalidate");
      return;
    }

    const responseId = message.responseId;
    if (!session.conversationId && typeof responseId === "string" && responseId.length > 0) {
      session.conversationId = responseId;
    }
    sync.record(session, context.messages, message);
    void this.persist([...context.messages, message]).catch((error) => {
      debugLog("session", "Could not persist Antigravity CLI runtime reference:", error);
    });

    this.runtime!.mcpServer.setToolCallHandler(null);
    if (!hasPendingCalls) {
      session.setRuntimeEventHandler(null);
      session.clearAbortSignal();
    }
  }

  private async persist(messages: readonly unknown[]): Promise<void> {
    const { session, store, loginEpoch } = this.options;
    if (!session.conversationId) return;

    await store.set(session.piSessionId, {
      conversationId: session.conversationId,
      ...(this.runtime!.mcpServer.hasPendingCalls ? { hasPendingToolCalls: true } : {}),
    }, messages, loginEpoch);
  }

  private failRuntime(error: Error): void {
    if (!this.ownsRuntime()) return;

    this.options.adapter.handleTermination("error", error.message);
    this.close("invalidate");
  }

  private cancel(message: string): void {
    const { session, adapter } = this.options;
    adapter.handleTermination("aborted", message);
    if (!this.ownsSession()) return;
    const mcpServer = this.runtime?.mcpServer ?? session.activeMcpServer;
    this.close(mcpServer?.hasPendingCalls ? "invalidate" : "preserve");
  }

  private close(reference: "invalidate" | "preserve"): void {
    const { session, store } = this.options;
    if (!this.ownsSession()) return;

    const mcpServer = this.runtime?.mcpServer ?? session.activeMcpServer;
    mcpServer?.setToolCallHandler(null);
    if (reference === "invalidate") {
      // The tombstone is written synchronously before asynchronous resource cleanup.
      void store.delete(session.piSessionId).catch((error) => {
        debugLog("session", "Could not invalidate failed Antigravity CLI runtime reference:", error);
      });
    }
    void session.dispose().catch((error) => {
      debugLog("session", "Could not dispose Antigravity CLI runtime:", error);
    });
  }
}
