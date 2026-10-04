import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readPluginManifest, resolveMcpEntrypoint } from "../discovery/plugin-install.ts";
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
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read-only checks; the only subprocess is AGY --version. */
export async function collectDoctorReport(options: DoctorOptions): Promise<string> {
  const lines: string[] = ["agy-bridge doctor (read-only)"];
  try {
    const executable = resolveAgyExecutable(options.agyPath);
    lines.push(`Resolved AGY path: ${executable}`);
    const minimum = options.minVersion ?? DEFAULT_MIN_AGY_VERSION;
    const { version } = await validateAgyVersion(executable, minimum);
    lines.push(`✓ AGY ${version} (minimum ${minimum})`);
  } catch (error) {
    lines.push(`✗ AGY error: ${message(error)}`);
  }

  try {
    const source = await readPluginManifest(path.join(path.resolve(options.pluginDir), "plugin.json"));
    if (!source) throw new Error(`Bundled plugin manifest not found: ${options.pluginDir}`);
    const target = path.join(os.homedir(), ".gemini", "config", "plugins", source.name);
    lines.push(`Plugin: ${source.name}; target: ${target}`);
    const installed = await readPluginManifest(path.join(target, "plugin.json"));
    if (!installed) {
      lines.push(`! Plugin not installed (bundled ${source.version})`, "Will install automatically on next AGY use.");
    } else if (installed.version === source.version) {
      lines.push(`✓ Plugin installed ${installed.version} (bundled ${source.version})`);
    } else {
      lines.push(`! Plugin installed ${installed.version} -> bundled ${source.version}`, "Will update automatically on next AGY use.");
    }
  } catch (error) {
    lines.push(`✗ Plugin error: ${message(error)}`);
  }

  if (options.models !== undefined) {
    lines.push(`${options.models.length > 0 ? "✓" : "!"} Models: ${options.models.length} configured`);
  } else {
    const count = options.catalogModels?.length ?? 0;
    lines.push(`${count > 0 ? "✓" : "!"} Models: ${count} cached (Pi models-store)`);
  }

  const authStatus = options.authStatus ?? "unknown";
  lines.push(`Authentication snapshot: ${authStatus}${authStatus === "unknown" ? " (not verified)" : ""}`);

  lines.push(`Node version: ${process.version}`);
  try {
    const { nodePath, entrypointPath } = resolveMcpEntrypoint();
    for (const [label, file] of [["Node executable", nodePath], ["MCP entrypoint", entrypointPath]] as const) {
      try {
        await fs.access(file);
        lines.push(`✓ ${label} exists: ${file} (existence only; spawning not tested)`);
      } catch (error) {
        lines.push(`✗ ${label} error: ${file}: ${message(error)}`);
      }
    }
  } catch (error) {
    lines.push(`✗ MCP error: ${message(error)}`);
  }
  if (process.platform === "win32") lines.push("! Windows: Unix socket support is not verified.");
  for (const [label, failure] of [["plugin", options.pluginError], ["discovery", options.discoveryError], ["authentication", options.authError]] as const) {
    if (failure) lines.push(`Last ${label} error at ${failure.time}: ${failure.message}`);
  }
  lines.push("Authentication is a last-known snapshot; live authentication is not tested. Model execution and Unix socket creation not tested.");
  return lines.join("\n");
}
