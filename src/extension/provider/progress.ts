import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ProgressUI = Pick<ExtensionContext["ui"], "setStatus">;

export class ProgressStatus {
  private readonly entries = new Map<symbol, { ui: ProgressUI; message: string }>();

  set(id: symbol, ui: ProgressUI | undefined, message: string | undefined): boolean {
    const previous = this.entries.get(id);
    if (message === undefined) {
      if (!previous) return false;
      const current = [...this.entries].filter(([, entry]) => entry.ui === previous.ui).at(-1)?.[0] === id;
      this.entries.delete(id);
      return current ? this.render(previous.ui) : true;
    }
    if (!ui) return false;
    this.entries.set(id, { ui, message });
    return this.render(ui);
  }

  show(ui: ProgressUI | undefined, message: string): () => void {
    const id = Symbol();
    this.set(id, ui, message);
    return () => { this.set(id, ui, undefined); };
  }

  clear(): void {
    const interfaces = new Set([...this.entries.values()].map((entry) => entry.ui));
    this.entries.clear();
    for (const ui of interfaces) this.render(ui);
  }

  private render(ui: ProgressUI): boolean {
    const message = [...this.entries.values()].filter((entry) => entry.ui === ui).at(-1)?.message;
    try { ui.setStatus("agy-bridge", message); return true; }
    catch { return false; }
  }
}
