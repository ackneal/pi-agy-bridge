import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readPluginManifest, resolveMcpEntrypoint } from "../discovery/plugin-install.ts";
import { formatDoctorQuotaLines, type AgyUsageSnapshot } from "../runtime/usage.ts";
import { DEFAULT_MIN_AGY_VERSION, resolveAgyExecutable, validateAgyVersion } from "../runtime/version.ts";

export interface DoctorFailure {
  time: string;
  message: string;
}
export interface DoctorOptions {
  agyPath?: string | undefined;
  minVersion?: string | undefined;
  pluginDir: string;
  models?: readonly unknown[] | undefined;
  catalogModels?: readonly unknown[] | undefined;
  pluginError?: DoctorFailure | undefined;
  discoveryError?: DoctorFailure | undefined;
  authStatus?: "authenticated" | "unauthenticated" | "unknown" | undefined;
  authError?: DoctorFailure | undefined;
  usageSnapshot?: AgyUsageSnapshot | undefined;
  usageError?: DoctorFailure | undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read-only checks; the only subprocess is Antigravity CLI --version. */
export async function collectDoctorReport(options: DoctorOptions): Promise<string> {
  const lines: string[] = ["agy-bridge doctor", "", "Runtime"];
  try {
    const executable = resolveAgyExecutable(options.agyPath);
    const minimum = options.minVersion ?? DEFAULT_MIN_AGY_VERSION;
    try {
      const { version } = await validateAgyVersion(executable, minimum);
      lines.push(`  ✓ Antigravity CLI ${version}`);
    } catch (error) {
      lines.push(`  ✗ Antigravity CLI error (${executable}): ${message(error)}`);
    }
  } catch (error) {
    lines.push(`  ✗ Antigravity CLI error: ${message(error)}`);
  }

  try {
    const source = await readPluginManifest(path.join(path.resolve(options.pluginDir), "plugin.json"));
    if (!source) throw new Error(`Bundled plugin manifest not found: ${options.pluginDir}`);
    const target = path.join(os.homedir(), ".gemini", "config", "plugins", source.name);
    const installed = await readPluginManifest(path.join(target, "plugin.json"));
    if (!installed) {
      lines.push(
        `  ! Plugin ${source.name} not installed (bundled ${source.version}) — ${target}`,
        "    Will install automatically on next Antigravity CLI use."
      );
    } else if (installed.version === source.version) {
      lines.push(`  ✓ Plugin ${installed.version}`);
    } else {
      lines.push(
        `  ! Plugin ${source.name} ${installed.version} -> bundled ${source.version} — ${target}`,
        "    Will update automatically on next Antigravity CLI use."
      );
    }
  } catch (error) {
    lines.push(`  ✗ Plugin error: ${message(error)}`);
  }

  try {
    const { nodePath, entrypointPath } = resolveMcpEntrypoint();
    for (const [label, file] of [
      [`Node ${process.version}`, nodePath],
      ["MCP entrypoint", entrypointPath],
    ] as const) {
      try {
        await fs.access(file);
        lines.push(`  ✓ ${label}${label === "MCP entrypoint" ? " found" : ""}`);
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
    ? (options.usageSnapshot ? "authenticated" : "unknown")
    : options.authStatus;
  const authMark = authStatus === "authenticated" ? "✓" : "!";
  lines.push(`  ${authMark} Auth: ${authStatus}`);

  if (process.platform === "win32") {
    lines.push("  ! Windows: Unix socket support is not verified.");
  }

  lines.push(...formatDoctorQuotaLines(options.usageSnapshot));

  const failures = [
    ["plugin", options.pluginError],
    ["discovery", options.discoveryError],
    ["authentication", options.authError],
    ["usage", options.usageError],
  ] as const;
  const activeFailures = failures.filter((entry): entry is [typeof entry[0], DoctorFailure] => entry[1] !== undefined);
  if (activeFailures.length > 0) {
    lines.push("", "Errors");
    for (const [label, failure] of activeFailures) {
      lines.push(`  ! ${label} (${failure.time}): ${failure.message}`);
    }
  }

  return lines.join("\n");
}
