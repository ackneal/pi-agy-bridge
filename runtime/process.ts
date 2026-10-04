import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { AgyProtocolParser } from "./protocol.ts";
import { AgyProcessError, type AgyEvent, type AgyInitEvent, type AgyInput } from "../shared/types.ts";
import { debugLog } from "../shared/debug.ts";
import { resolveAgyExecutable } from "./version.ts";

export interface AgyProcessOptions {
  agyPath?: string | undefined;
  agentName: string;
  model: string;
  conversationId?: string | undefined;
  effort?: "low" | "medium" | "high" | undefined;
  cwd?: string | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  disableSlashCommands?: boolean | undefined;
}

export class AgyRuntime {
  public readonly options: AgyProcessOptions;
  private child: ChildProcess | null = null;
  private parser: AgyProtocolParser;
  private listeners = new Set<(event: AgyEvent) => void>();
  private eventWaiters = new Set<() => void>();
  private eventStreamEnded = false;
  private stderrBuffer = "";
  private isTerminated = false;
  private hasTurnResult = false;
  private nodeExitListener: (() => void) | null = null;

  constructor(options: AgyProcessOptions) {
    this.options = options;
    this.parser = new AgyProtocolParser();
  }

  public get isRunning(): boolean {
    return (
      this.child !== null &&
      this.child.exitCode === null &&
      !this.child.killed &&
      !this.isTerminated
    );
  }

  public async start(): Promise<AgyInitEvent> {
    if (this.child) {
      throw new AgyProcessError("Process is already started");
    }

    const agyPath = resolveAgyExecutable(this.options.agyPath);
    const args = [
      "--agent",
      this.options.agentName,
      "--model",
      this.options.model,
    ];

    if (this.options.conversationId) {
      args.push("--conversation", this.options.conversationId);
    }

    args.push("--input-format", "stream-json", "--output-format", "stream-json");

    if (this.options.effort) {
      args.push("--effort", this.options.effort);
    }

    if (this.options.disableSlashCommands ?? true) {
      args.push("--disable-slash-commands");
    }

    debugLog(
      "process",
      `Spawning: ${agyPath} ${args.join(" ")} (cwd: ${this.options.cwd ?? process.cwd()})`
    );

    const spawnEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.options.environment,
    };

    this.child = spawn(agyPath, args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: spawnEnv,
    });

    this.nodeExitListener = () => {
      if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    };
    process.on("exit", this.nodeExitListener);

    this.child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      this.stderrBuffer += text;
      if (this.stderrBuffer.length > 32768) {
        this.stderrBuffer = this.stderrBuffer.slice(-32768);
      }
      debugLog("process", `[stderr] ${text.trimEnd()}`);
    });

    const stdoutDecoder = new StringDecoder("utf8");
    this.child.stdout?.on("data", (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk);
      const events = this.parser.push(text);
      for (const event of events) {
        this.dispatchEvent(event);
      }
    });

    this.child.stdout?.on("end", () => {
      const remaining = [
        ...this.parser.push(stdoutDecoder.end()),
        ...this.parser.flush(),
      ];
      for (const event of remaining) {
        this.dispatchEvent(event);
      }
    });

    return new Promise<AgyInitEvent>((resolve, reject) => {
      let settled = false;
      let unsubscribe = () => {};

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        this.cleanupNodeExitListener();
        this.isTerminated = true;
        this.endEventStream();

        if (!settled) {
          settled = true;
          unsubscribe();
          const recentStderr = this.stderrBuffer.trim();
          const detail = recentStderr ? `: ${recentStderr.slice(-500)}` : "";
          reject(
            new AgyProcessError(
              `agy process exited prematurely with code ${code} and signal ${signal}${detail}`,
              { exitCode: code, signal, stderr: this.stderrBuffer }
            )
          );
          return;
        }

        if (this.hasTurnResult) return;

        debugLog("process", `Process exited post-init with code ${code}, signal ${signal}`);
        const recentStderr = this.stderrBuffer.trim();
        const detail = recentStderr ? `: ${recentStderr.slice(-500)}` : "";
        this.dispatchEvent({
          event: "result",
          status: "error",
          error: {
            message: `Antigravity CLI process terminated unexpectedly (exit code ${code ?? "null"}, signal ${signal ?? "none"})${detail}`,
          },
        });
      };

      const onError = (err: Error) => {
        this.cleanupNodeExitListener();
        this.isTerminated = true;
        this.endEventStream();

        if (!settled) {
          settled = true;
          unsubscribe();
          reject(
            new AgyProcessError(`Failed to spawn agy process: ${err.message}`, {
              stderr: this.stderrBuffer,
            })
          );
          return;
        }

        debugLog("process", `Process error post-init: ${err.message}`);
        this.dispatchEvent({
          event: "result",
          status: "error",
          error: {
            message: `Antigravity CLI process error: ${err.message}`,
          },
        });
      };

      // close follows stdout end, so buffered results settle before termination.
      this.child!.once("close", onExit);
      this.child!.once("error", onError);

      unsubscribe = this.onEvent((event) => {
        if (event.event === "init") {
          if (!settled) {
            settled = true;
            unsubscribe();
            resolve(event as AgyInitEvent);
          }
        }
      });
    });
  }

  public async send(input: AgyInput): Promise<void> {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed || this.isTerminated) {
      throw new AgyProcessError(
        "Cannot send turn: agy child process is not running or stdin is closed",
        { stderr: this.stderrBuffer }
      );
    }

    const payload = `${JSON.stringify(input)}\n`;
    this.hasTurnResult = false;

    await new Promise<void>((resolve, reject) => {
      this.child!.stdin!.write(payload, "utf-8", (err) => {
        if (err) {
          reject(
            new AgyProcessError(`Failed to write turn to stdin: ${err.message}`, {
              stderr: this.stderrBuffer,
            })
          );
        } else {
          resolve();
        }
      });
    });
  }

  public async *events(): AsyncIterable<AgyEvent> {
    const queue: AgyEvent[] = [];
    let waiter: (() => void) | undefined;
    const unsubscribe = this.onEvent((event) => {
      queue.push(event);
      waiter?.();
      if (waiter) this.eventWaiters.delete(waiter);
      waiter = undefined;
    });

    try {
      while (true) {
        const event = queue.shift();
        if (event) {
          yield event;
          continue;
        }
        if (this.eventStreamEnded) return;
        await new Promise<void>((resolve) => {
          waiter = resolve;
          this.eventWaiters.add(resolve);
        });
        if (waiter) this.eventWaiters.delete(waiter);
        waiter = undefined;
      }
    } finally {
      unsubscribe();
    }
  }

  public onEvent(listener: (event: AgyEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async abort(): Promise<void> {
    this.listeners.clear();
    this.endEventStream();
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null || this.isTerminated) {
      this.cleanupNodeExitListener();
      return;
    }

    const child = this.child;
    return new Promise<void>((resolve) => {
      let done = false;
      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (!done) {
          done = true;
          if (timer) clearTimeout(timer);
          this.cleanupNodeExitListener();
          this.isTerminated = true;
          resolve();
        }
      };

      child.once("exit", cleanup);

      try {
        child.kill("SIGINT");
      } catch {
        cleanup();
        return;
      }

      timer = setTimeout(() => {
        if (!done && child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
        cleanup();
      }, 2000);

      if (timer.unref) {
        timer.unref();
      }
    });
  }

  private endEventStream(): void {
    this.eventStreamEnded = true;
    for (const wake of this.eventWaiters) wake();
    this.eventWaiters.clear();
  }

  private dispatchEvent(event: AgyEvent): void {
    if (event.event === "result") this.hasTurnResult = true;
    for (const wake of this.eventWaiters) wake();

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        debugLog("process", "Error in event listener:", err);
      }
    }
  }

  private cleanupNodeExitListener(): void {
    if (this.nodeExitListener) {
      process.removeListener("exit", this.nodeExitListener);
      this.nodeExitListener = null;
    }
  }
}

export { AgyRuntime as AgyProcess };
