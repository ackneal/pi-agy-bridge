import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export interface AcpConnectionOptions {
  executable: string;
  cwd: string;
  args?: string[];
  requestTimeoutMs?: number;
  allowInteractiveAuthentication?: boolean;
  onUpdate?: (notification: acp.SessionNotification) => void | Promise<void>;
  onClose?: (error: unknown) => void;
  onPermission?: (request: acp.RequestPermissionRequest) => acp.RequestPermissionResponse | Promise<acp.RequestPermissionResponse>;
  onRead?: (request: acp.ReadTextFileRequest, signal: AbortSignal) => Promise<acp.ReadTextFileResponse>;
}

export class AcpConnection {
  private child: ChildProcessWithoutNullStreams | undefined;
  private sdk: acp.ClientConnection | undefined;
  private startup: Promise<acp.InitializeResponse> | undefined;
  private disposal: Promise<void> | undefined;
  private closed: Promise<void> = Promise.resolve();
  private stopped = false;
  private termination: Promise<void> = Promise.resolve();
  private hostExitHandler: (() => void) | undefined;
  private readonly shutdown = new AbortController();
  private readonly options: AcpConnectionOptions;

  constructor(options: AcpConnectionOptions) {
    if (!Number.isFinite(options.requestTimeoutMs ?? 180_000) || (options.requestTimeoutMs ?? 180_000) <= 0) {
      throw new Error("ACP request timeout must be positive and finite");
    }
    this.options = options;
  }

  get isRunning(): boolean {
    return !!this.child && !this.stopped && !this.sdk?.signal.aborted;
  }

  start(signal?: AbortSignal): Promise<acp.InitializeResponse> {
    if (this.startup) return this.startup;
    this.startup = this.initialize(signal);
    return this.startup;
  }

  private async initialize(signal?: AbortSignal): Promise<acp.InitializeResponse> {
    if (this.stopped) throw new Error("ACP connection disposed");
    signal?.throwIfAborted();
    if (process.platform === "win32") throw new Error("ACP owned process groups require POSIX");

    let env = process.env;
    if (!this.options.allowInteractiveAuthentication) {
      const blocker = fileURLToPath(new URL("./noninteractive-browser.js", import.meta.url));
      accessSync(blocker, constants.R_OK);
      env = { ...process.env, BROWSER: `${JSON.stringify(process.execPath)} ${JSON.stringify(blocker)} %s` };
    }

    const child = spawn(this.options.executable, this.options.args ?? [], {
      cwd: this.options.cwd, stdio: "pipe", detached: true, env,
    });
    this.child = child;
    if (child.pid !== undefined) {
      this.hostExitHandler = () => {
        // exit handlers cannot await TERM escalation or asynchronous disposal.
        try { this.signalGroup("SIGKILL"); }
        catch (error) {
          writeSync(2, `ACP host-exit cleanup failed: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}\n`);
          process.exitCode = 1;
        }
      };
      process.on("exit", this.hostExitHandler);
    }
    this.closed = new Promise((resolve) => child.once("close", () => {
      this.stop(new Error(`ACP process closed (${child.exitCode ?? child.signalCode})`));
      resolve();
    }));
    child.on("error", (error) => this.stop(error));
    if (this.options.allowInteractiveAuthentication) {
      child.stderr.resume();
    } else {
      const marker = "Open the following link to authenticate the ACP server:";
      let tail = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        const output = tail + chunk;
        if (output.includes(marker)) {
          this.stop(new acp.RequestError(-32000, "Authentication required. Run /login to authenticate."));
        }
        tail = output.slice(-marker.length);
      });
    }
    // Stream errors also occur on failed spawn and broken pipes.
    child.stdin.on("error", (error) => this.stop(error));
    child.stdout.on("error", (error) => this.stop(error));

    this.sdk = acp.client({ name: "pi-agy-bridge" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (!this.stopped) return this.options.onUpdate?.(params);
      })
      .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => {
        if (this.stopped || !this.options.onRead) throw new acp.RequestError(-32601, "ACP client reads are unavailable");
        return this.options.onRead(params, this.shutdown.signal);
      })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) =>
        !this.stopped && this.options.onPermission
          ? this.options.onPermission(params)
          : { outcome: { outcome: "cancelled" } })
      .connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
    void this.sdk.closed.then(() => this.stop(new Error("ACP transport closed")));

    const abort = () => this.stop(signal?.reason ?? new Error("ACP startup cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      return await this.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: this.options.onRead ? { fs: { readTextFile: true } } : {},
        clientInfo: { name: "pi-agy-bridge", version: "0.4.0" },
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

  async request<M extends acp.AgentRequestMethod>(method: M, params: acp.AgentRequestParamsByMethod[M]): Promise<acp.AgentRequestResponsesByMethod[M]> {
    this.shutdown.signal.throwIfAborted();
    if (!this.isRunning || !this.sdk) throw new Error("ACP connection is not running");
    return this.bounded(() => this.sdk!.agent.request(method, params), method, method !== acp.methods.agent.session.prompt);
  }

  async notify<M extends acp.AgentNotificationMethod>(method: M, params: acp.AgentNotificationParamsByMethod[M]): Promise<void> {
    if (!this.isRunning || !this.sdk) throw new Error("ACP connection is not running");
    await this.bounded(() => this.sdk!.agent.notify(method, params), method);
  }

  private async bounded<T>(operation: () => Promise<T>, method: string, timeout = true): Promise<T> {
    const signal = this.shutdown.signal;
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    // Prompts can wait indefinitely for tools; only shutdown bounds their lifetime.
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
    this.shutdown.abort(error);
    // detached POSIX spawn owns a new group; never signal the host agent's group.
    const pid = this.child?.pid;
    if (pid !== undefined) {
      this.termination = new Promise<void>((resolve, reject) => {
        const errors: unknown[] = [];
        try { this.signalGroup("SIGTERM"); } catch (error) { errors.push(error); }
        // Parent close and TERM errors must not cancel or preempt escalation.
        setTimeout(() => {
          try { this.signalGroup("SIGKILL"); } catch (error) { errors.push(error); }
          if (this.hostExitHandler) {
            process.off("exit", this.hostExitHandler);
            this.hostExitHandler = undefined;
          }
          if (errors.length > 0) reject(new AggregateError(errors, "ACP process-group cleanup failed"));
          else resolve();
        }, 200);
      });
      // Natural close can initiate cleanup before dispose is called.
      void this.termination.catch(() => {});
    }
    this.sdk?.close(error);
    this.child?.stdin.destroy();
    this.child?.stdout.destroy();
    this.child?.stderr.destroy();
    this.options.onClose?.(error);
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
