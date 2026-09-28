let bridgeConfigDebug = false;

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

function formatDebugValue(value: unknown): string {
  if (typeof value !== "object" || value === null) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
