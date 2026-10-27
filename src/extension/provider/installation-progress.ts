import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AcpInstallProgress } from "../drivers/acp/installation.ts";
import { ProgressStatus } from "./progress.ts";

type ProgressUI = Pick<ExtensionContext["ui"], "setStatus" | "notify">;

export class AcpInstallationProgress {
  private readonly getUI: () => ProgressUI | undefined;
  private readonly write: (message: string) => void;
  private readonly statusManager: ProgressStatus;
  private readonly statusId = Symbol();
  private lastProgress: AcpInstallProgress | undefined;
  private lastStderrAt = -Infinity;

  constructor(
    getUI: () => ProgressUI | undefined,
    write: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
    statusManager = new ProgressStatus(),
  ) {
    this.getUI = getUI;
    this.statusManager = statusManager;
    this.write = write;
  }

  update(progress: AcpInstallProgress): void {
    if (this.lastProgress === progress) return;
    const previousPhase = this.lastProgress?.phase;
    this.lastProgress = progress;
    const ui = this.getUI();

    if (progress.phase === "complete" || progress.phase === "error" || progress.phase === "cancelled") {
      this.status(ui, undefined);
      if (progress.phase === "error") this.notify(ui, progress.message);
      else if (!ui) this.write(progress.message);
      return;
    }

    const displayed = this.status(ui, progress.message);
    const now = Date.now();
    if (!displayed && (progress.phase !== previousPhase || now - this.lastStderrAt >= 2000)) {
      this.write(progress.message);
      this.lastStderrAt = now;
    }
  }

  clear(): void {
    this.lastProgress = undefined;
    this.lastStderrAt = -Infinity;
    this.status(this.getUI(), undefined);
  }

  private status(ui: ProgressUI | undefined, message: string | undefined): boolean {
    return this.statusManager.set(this.statusId, ui, message);
  }

  private notify(ui: ProgressUI | undefined, message: string): void {
    if (ui) {
      try { ui.notify(message, "error"); return; }
      catch { /* A broken UI must not stop the installation or hide its error. */ }
    }
    this.write(message);
  }
}
