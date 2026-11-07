import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { debugLog } from "../../shared/debug.ts";
import { version } from "../../../version.js";

export interface ConnectionOptions {
  executable: string;
  cwd: string;
  args?: string[];
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  allowInteractiveAuthentication?: boolean;
  onUpdate?: (notification: acp.SessionNotification) => void | Promise<void>;
  onClose?: (error: unknown) => void;
}

export class Connection {
  private child: ChildProcessWithoutNullStreams | undefined;
  private sdk: acp.ClientConnection | undefined;
  private startup: Promise<acp.InitializeResponse> | undefined;
  private disposal: Promise<void> | undefined;
  private closed: Promise<void> = Promise.resolve();
  private stopped = false;
  private termination: Promise<void> = Promise.resolve();
  private hostExitHandler: (() => void) | undefined;
  private readonly updateHandlers = new Set<(notification: acp.SessionNotification) => void | Promise<void>>();
  private readonly closeHandlers = new Set<(error: unknown) => void>();
  private readonly shutdown = new AbortController();
  private readonly options: ConnectionOptions;

  constructor(options: ConnectionOptions) {
    if (!Number.isFinite(options.requestTimeoutMs ?? 180_000) || (options.requestTimeoutMs ?? 180_000) <= 0) {
      throw new Error("ACP request timeout must be positive and finite");
    }
    this.options = options;
  }

  get isRunning(): boolean {
    return !!this.child && !this.stopped && !this.sdk?.signal.aborted;
  }

  onSessionUpdate(handler: (notification: acp.SessionNotification) => void | Promise<void>): () => void {
    if (this.stopped) return () => {};

    this.updateHandlers.add(handler);
    return () => { this.updateHandlers.delete(handler); };
  }

  onClose(handler: (error: unknown) => void): () => void {
    if (this.stopped) return () => {};

    this.closeHandlers.add(handler);
    return () => { this.closeHandlers.delete(handler); };
  }

  start(signal?: AbortSignal): Promise<acp.InitializeResponse> {
    if (this.stopped) return Promise.reject(this.shutdown.signal.reason);
    if (this.startup) return this.startup;
    this.startup = this.initialize(signal);
    return this.startup;
  }

  private async initialize(signal?: AbortSignal): Promise<acp.InitializeResponse> {
    if (this.stopped) throw new Error("ACP connection disposed");
    signal?.throwIfAborted();
    if (process.platform === "win32") throw new Error("ACP owned process groups require POSIX");

    let env: NodeJS.ProcessEnv = { ...process.env, ...this.options.environment };
    if (!this.options.allowInteractiveAuthentication) {
      const blocker = fileURLToPath(new URL("../acp/noninteractive-browser.js", import.meta.url));
      accessSync(blocker, constants.R_OK);
      env = { ...env, BROWSER: `${JSON.stringify(process.execPath)} ${JSON.stringify(blocker)} %s` };
    }
    const child = spawn(this.options.executable, this.options.args ?? [], {
      cwd: this.options.cwd,
      stdio: "pipe",
      detached: true,
      env,
    });
    this.child = child;

    if (child.pid !== undefined) {
      this.hostExitHandler = () => {
        try { this.signalGroup("SIGKILL"); }
        catch (error) {
          writeSync(2, `ACP host-exit cleanup failed: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}\n`);
          process.exitCode = 1;
        }
      };
      process.on("exit", this.hostExitHandler);
    }

    this.closed = new Promise((resolve) => child.once("close", (code, signalCode) => {
      this.stop(new Error(`ACP process closed (${code ?? signalCode})`));
      resolve();
    }));

    child.on("error", (error) => this.stop(error));
    child.stdin.on("error", (error) => this.stop(error));
    child.stdout.on("error", (error) => this.stop(error));
    const marker = "Open the following link to authenticate the ACP server:";
    let tail = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      debugLog("acp", `[agy acp stderr] ${chunk.trim()}`);
      if (this.options.allowInteractiveAuthentication) return;
      const output = tail + chunk;
      if (output.includes(marker)) {
        this.stop(new acp.RequestError(-32000, "Authentication required. Run /login to authenticate."));
      }
      tail = output.slice(-marker.length);
    });

    this.sdk = acp.client({ name: "pi-agy-bridge" })
      .onNotification(acp.methods.client.session.update, async ({ params }) => {
        if (this.stopped) return;

        const handlers = [...this.updateHandlers];
        await this.options.onUpdate?.(params);
        for (const handler of handlers) {
          if (this.stopped) return;
          if (this.updateHandlers.has(handler)) await handler(params);
        }
      })
      .connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));

    const sdk = this.sdk;
    void sdk.closed.then(() => {
      queueMicrotask(() => {
        const reason = sdk.signal.reason;
        const details = reason instanceof Error && reason.message !== "ACP connection closed" ? `: ${reason.message}` : "";
        this.stop(new Error(`ACP transport closed${details}`));
      });
    });

    const abort = () => this.stop(signal?.reason ?? new Error("ACP startup cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();

    try {
      return await this.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "pi-agy-bridge", version },
      });
    } catch (error) {
      try {
        await this.dispose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `ACP startup failed: ${error instanceof Error ? error.message : String(error)}; cleanup failed`);
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async request<M extends acp.AgentRequestMethod | string>(method: M, params: unknown): Promise<any> {
    this.shutdown.signal.throwIfAborted();
    if (!this.isRunning || !this.sdk) throw new Error("ACP connection is not running");
    return this.bounded(() => (this.sdk!.agent as any).request(method, params), method, method !== acp.methods.agent.session.prompt);
  }

  async notify<M extends acp.AgentNotificationMethod | string>(method: M, params: unknown): Promise<void> {
    if (!this.isRunning || !this.sdk) throw new Error("ACP connection is not running");
    await this.bounded(() => (this.sdk!.agent as any).notify(method, params), method);
  }

  private async bounded<T>(operation: () => Promise<T>, method: string, timeout = true): Promise<T> {
    const signal = this.shutdown.signal;
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });

    const timer = timeout
      ? setTimeout(() => this.stop(new Error(`ACP request timeout: ${method}`)), this.options.requestTimeoutMs ?? 180_000)
      : undefined;

    try {
      return await Promise.race([operation(), stopped]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  private stop(error: unknown): void {
    if (this.stopped) return;
    this.stopped = true;
    const closeHandlers = [...this.closeHandlers];
    this.closeHandlers.clear();
    this.updateHandlers.clear();
    this.shutdown.abort(error);

    const pid = this.child?.pid;
    if (pid !== undefined) {
      this.termination = new Promise<void>((resolve, reject) => {
        const errors: unknown[] = [];
        try { this.signalGroup("SIGTERM"); } catch (err) { errors.push(err); }
        setTimeout(() => {
          try { this.signalGroup("SIGKILL"); } catch (err) { errors.push(err); }
          if (this.hostExitHandler) {
            process.off("exit", this.hostExitHandler);
            this.hostExitHandler = undefined;
          }
          if (errors.length > 0) reject(new AggregateError(errors, "ACP process-group cleanup failed"));
          else resolve();
        }, 200);
      });
      void this.termination.catch(() => {});
    }

    this.sdk?.close(error);
    this.child?.stdin?.destroy();
    this.child?.stdout?.destroy();
    this.child?.stderr?.destroy();
    this.options.onClose?.(error);
    for (const handler of closeHandlers) handler(error);
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (pid === undefined) return;

    try { process.kill(-pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.stop(new Error("ACP connection disposed"));
      this.disposal = this.finishDisposal();
    }
    return this.disposal;
  }

  private async finishDisposal(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("ACP process did not close within the cleanup deadline")), 2000);
    });

    try {
      const results = await Promise.race([Promise.allSettled([this.closed, this.termination]), deadline]);
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), "ACP cleanup failed");
    } finally {
      clearTimeout(timer);
    }
  }
}
