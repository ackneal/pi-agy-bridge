import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DriverInstallationProgress } from "../drivers/types.ts";
import { ProgressStatus } from "./progress.ts";

type ProgressUI = Pick<ExtensionContext["ui"], "setStatus" | "notify">;

export class AcpInstallationProgress {
  private readonly getUI: () => ProgressUI | undefined;
  private readonly write: (message: string) => void;
  private readonly statusManager: ProgressStatus;
  private readonly statusId = Symbol();
  private lastProgress: DriverInstallationProgress | undefined;
  private lastStderrAt = -Infinity;

  constructor(
    getUI: () => ProgressUI | undefined,
    write: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
    statusManager = new ProgressStatus(),
  ) {
    this.getUI = getUI;
    this.write = write;
    this.statusManager = statusManager;
  }

  update(progress: DriverInstallationProgress): void {
    if (progress.phase === "validate" || this.lastProgress === progress) return;
    const previousPhase = this.lastProgress?.phase;
    this.lastProgress = progress;
    const ui = this.getUI();

    if (progress.phase === "complete" || progress.phase === "error" || progress.phase === "cancelled") {
      this.statusManager.set(this.statusId, ui, undefined);
      if (progress.phase === "error") this.notify(ui, progress.message);
      else if (!ui && (previousPhase === "download" || previousPhase === "verify" || previousPhase === "extract")) this.write(progress.message);
      return;
    }

    const displayed = this.statusManager.set(this.statusId, ui, progress.message);
    const now = Date.now();
    if (!displayed && (progress.phase !== previousPhase || now - this.lastStderrAt >= 2000)) {
      this.write(progress.message);
      this.lastStderrAt = now;
    }
  }

  clear(): void {
    this.lastProgress = undefined;
    this.lastStderrAt = -Infinity;
    this.statusManager.set(this.statusId, this.getUI(), undefined);
  }

  private notify(ui: ProgressUI | undefined, message: string): void {
    if (ui) {
      try { ui.notify(message, "error"); return; }
      catch { /* A broken UI must not hide an actionable error. */ }
    }
    this.write(message);
  }
}
