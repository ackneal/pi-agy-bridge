import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let bridgeConfigDebug = false;
let artifactDirectory: string | undefined;
let artifactSequence = 0;

export function setDebugOverride(enabled: boolean): void {
  bridgeConfigDebug = enabled;
}

export function isDebugEnabled(): boolean {
  if (bridgeConfigDebug) {
    return true;
  }

  const envVal = process.env["AGY_BRIDGE_DEBUG"];
  return envVal === "1" || envVal?.toLowerCase() === "true";
}

export function debugLog(scope: string, ...args: unknown[]): void {
  if (!isDebugEnabled()) {
    return;
  }

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [agy:${scope}]`;

  const message = args.length > 0
    ? ` ${args.map(formatDebugValue).join(" ")}`
    : "";

  process.stderr.write(`${prefix}${message}\n`);
}

export function debugArtifact(label: string, value: unknown): void {
  if (!isDebugEnabled()) return;

  try {
    if (!artifactDirectory) {
      const configuredDirectory = process.env["AGY_BRIDGE_DEBUG_DIR"];
      if (configuredDirectory) {
        mkdirSync(configuredDirectory, { recursive: true, mode: 0o700 });
        artifactDirectory = configuredDirectory;
      } else {
        artifactDirectory = mkdtempSync(path.join(os.tmpdir(), "pi-agy-debug-"));
      }
    }

    const filename = path.join(artifactDirectory, `${process.pid}-${++artifactSequence}-${label}.json`);
    writeFileSync(filename, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
    debugLog("debug", "Saved diagnostic artifact:", filename);
  } catch (error) {
    debugLog("debug", "Could not save diagnostic artifact:", error);
  }
}

function formatDebugValue(value: unknown): string {
  if (typeof value !== "object" || value === null) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
