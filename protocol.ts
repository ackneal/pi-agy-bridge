import type { AgyEvent } from "./types.ts";
import { debugLog } from "./debug.ts";

export class AgyProtocolParser {
  private buffer = "";

  public push(chunk: string): AgyEvent[] {
    this.buffer += chunk;
    const events: AgyEvent[] = [];

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      const parsed = this.parseLine(line);
      if (parsed !== null) {
        events.push(parsed);
      }
    }

    return events;
  }

  public flush(): AgyEvent[] {
    const events: AgyEvent[] = [];

    if (this.buffer.trim().length > 0) {
      const parsed = this.parseLine(this.buffer);
      if (parsed !== null) {
        events.push(parsed);
      }
    }

    this.buffer = "";
    return events;
  }

  public reset(): void {
    this.buffer = "";
  }

  public getRemainder(): string {
    return this.buffer;
  }

  private parseLine(line: string): AgyEvent | null {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as AgyEvent;
      }

      debugLog("protocol", `Skipping non-object JSON value: "${trimmed}"`);
      return null;
    } catch (err) {
      debugLog("protocol", `Malformed JSON line ignored: "${trimmed}". Error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
