import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AcpInstallProgress } from "../drivers/acp/installation.ts";

type ProgressUI = Pick<ExtensionContext["ui"], "setStatus" | "notify">;

export class AcpInstallationProgress {
  private readonly getUI: () => ProgressUI | undefined;
  private readonly write: (message: string) => void;
  private lastProgress: AcpInstallProgress | undefined;
  private lastStderrAt = -Infinity;
  private downloaded = false;

  constructor(getUI: () => ProgressUI | undefined, write: (message: string) => void = (message) => process.stderr.write(`${message}\n`)) {
    this.getUI = getUI;
    this.write = write;
  }

  update(progress: AcpInstallProgress): void {
    if (this.lastProgress === progress) return;
    const previousPhase = this.lastProgress?.phase;
    this.lastProgress = progress;
    const ui = this.getUI();

    if (progress.phase === "complete" || progress.phase === "error" || progress.phase === "cancelled") {
      this.status(ui, undefined);
      if (progress.phase === "error") this.notify(ui, progress.message, "error");
      else if (progress.phase === "complete" && this.downloaded) this.notify(ui, progress.message, "info");
      else if (!ui) this.write(progress.message);
      this.downloaded = false;
      return;
    }

    if (progress.phase === "download" && !this.downloaded) {
      this.downloaded = true;
      if (ui) this.notify(ui, `Installing Antigravity ACP ${progress.version} (${progress.platform}). The first download may take several minutes.`, "info");
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
    this.downloaded = false;
    this.lastStderrAt = -Infinity;
    this.status(this.getUI(), undefined);
  }

  private status(ui: ProgressUI | undefined, message: string | undefined): boolean {
    if (!ui) return false;
    try { ui.setStatus("pi-agy-bridge:acp-install", message); return true; }
    catch { return false; }
  }

  private notify(ui: ProgressUI | undefined, message: string, type: "info" | "error"): void {
    if (ui) {
      try { ui.notify(message, type); return; }
      catch { /* A broken UI must not stop the installation or hide its error. */ }
    }
    this.write(message);
  }
}
