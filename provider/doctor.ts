import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readPluginManifest, resolveMcpEntrypoint } from "../discovery/plugin-install.ts";
import { MODEL_CACHE_PATH } from "../discovery/models.ts";
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
  pluginError?: DoctorFailure | undefined;
  discoveryError?: DoctorFailure | undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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
    try {
      const value: unknown = JSON.parse(await fs.readFile(MODEL_CACHE_PATH, "utf8"));
      if (!Array.isArray(value) || !value.every(model =>
        model !== null && typeof model === "object" && !Array.isArray(model) &&
        typeof model.id === "string" && typeof model.name === "string")) {
        throw new Error(`Invalid model cache: ${MODEL_CACHE_PATH}`);
      }
      lines.push(`${value.length > 0 ? "✓" : "!"} Models: ${value.length} cached (${MODEL_CACHE_PATH})`);
    } catch (error) {
      lines.push(missing(error) ? `! Models: no cache (${MODEL_CACHE_PATH})` : `✗ Model cache error: ${message(error)}`);
    }
  }

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
  for (const [label, failure] of [["plugin", options.pluginError], ["discovery", options.discoveryError]] as const) {
    if (failure) lines.push(`Last ${label} error at ${failure.time}: ${failure.message}`);
  }
  lines.push("Authentication, model execution, and Unix socket creation not tested.");
  return lines.join("\n");
}
