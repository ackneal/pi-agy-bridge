import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_AGY_PLUGIN_DIR, readPluginManifest, resolveMcpEntrypoint } from "../discovery/plugin-install.ts";
import { formatDoctorQuotaLines, type AgyUsage } from "../runtime/usage.ts";
import { validateAgyVersion } from "../runtime/version.ts";
import { readVersion } from "../drivers/acp/version.ts";
import type { DriverFailure, DriverId } from "../drivers/types.ts";

export interface DoctorOptions {
  driver: DriverId;
  executable?: string | undefined;
  pluginDir?: string | undefined;
  models?: readonly unknown[] | undefined;
  catalogModels?: readonly unknown[] | undefined;
  pluginError?: DriverFailure | undefined;
  discoveryError?: DriverFailure | undefined;
  authStatus?: "authenticated" | "unauthenticated" | "saved" | "unknown" | undefined;
  authError?: DriverFailure | undefined;
  usage?: AgyUsage | undefined;
  usageError?: DriverFailure | undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read-only checks; the only subprocess is the selected executable's --version. */
export async function collectDoctorReport(options: DoctorOptions): Promise<string> {
  const label = options.driver === "cli" ? "Antigravity CLI" : "Antigravity ACP";
  let runtimeLine: string;
  try {
    if (!options.executable?.trim()) throw new Error("Executable not found");
    const version = options.driver === "cli"
      ? (await validateAgyVersion(options.executable)).version
      : await readVersion(options.executable);
    runtimeLine = `  ✓ ${label}${version ? ` ${version}` : ""}`;
  } catch (error) {
    runtimeLine = `  ✗ ${label} error${options.executable ? ` (${options.executable})` : ""}: ${message(error)}`;
  }

  const pluginLines: string[] = [];
  if (options.driver === "cli") {
    const pluginDir = options.pluginDir ?? DEFAULT_AGY_PLUGIN_DIR;
    try {
      const source = await readPluginManifest(path.join(path.resolve(pluginDir), "plugin.json"));
      if (!source) throw new Error(`Bundled plugin manifest not found: ${pluginDir}`);
      const target = path.join(os.homedir(), ".gemini", "config", "plugins", source.name);
      const installed = await readPluginManifest(path.join(target, "plugin.json"));
      if (!installed) {
        pluginLines.push(
          `  ! Plugin ${source.name} not installed (bundled ${source.version}) — ${target}`,
          "    Will install automatically on next Antigravity CLI use."
        );
      } else if (installed.version === source.version) {
        runtimeLine += ` (Plugin ${installed.version})`;
      } else {
        pluginLines.push(
          `  ! Plugin ${source.name} ${installed.version} -> bundled ${source.version} — ${target}`,
          "    Will update automatically on next Antigravity CLI use."
        );
      }
    } catch (error) {
      pluginLines.push(`  ✗ Plugin error: ${message(error)}`);
    }
  }

  const lines = ["agy-bridge doctor", "", "Runtime", runtimeLine, ...pluginLines];

  try {
    const { nodePath, entrypointPath } = resolveMcpEntrypoint();
    for (const [label, file] of [
      [`Node ${process.version}`, nodePath],
      ["Pi MCP bridge entrypoint", entrypointPath],
    ] as const) {
      try {
        await fs.access(file);
        lines.push(`  ✓ ${label}${label === "Pi MCP bridge entrypoint" ? " found" : ""}`);
      } catch (error) {
        lines.push(`  ✗ ${label} error (${file}): ${message(error)}`);
      }
    }
  } catch (error) {
    lines.push(`  ✗ MCP error: ${message(error)}`);
  }

  if (options.models !== undefined) {
    lines.push(`  ${options.models.length > 0 ? "✓" : "!"} Models: ${options.models.length} configured`);
  } else {
    const count = options.catalogModels?.length ?? 0;
    lines.push(`  ${count > 0 ? "✓" : "!"} Models: ${count} cached`);
  }

  const authStatus = options.authStatus === "unknown" || options.authStatus === undefined
    ? (options.usage ? "authenticated" : "unknown")
    : options.authStatus;
  const authMark = authStatus === "authenticated" ? "✓" : "x";
  const authLabel = authStatus === "saved" ? "saved login (backend unverified)" : authStatus;
  lines.push(`  ${authMark} Auth: ${authLabel}`);

  if (process.platform === "win32") {
    lines.push("  ! Windows: Unix socket support is not verified.");
  }

  lines.push(...(options.driver === "cli"
    ? formatDoctorQuotaLines(options.usage)
    : ["", "Quota remaining (unavailable)"]));

  const failures = [
    ["plugin", options.pluginError],
    ["discovery", options.discoveryError],
    ["authentication", options.authError],
    ["usage", options.usageError],
  ] as const;
  const activeFailures = failures.filter((entry): entry is [typeof entry[0], DriverFailure] => entry[1] !== undefined);
  if (activeFailures.length > 0) {
    lines.push("", "Errors");
    for (const [label, failure] of activeFailures) {
      lines.push(`  ! ${label} (${failure.time}): ${failure.message}`);
    }
  }

  return lines.join("\n");
}
