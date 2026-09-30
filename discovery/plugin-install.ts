import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { debugLog } from "../shared/debug.ts";
import { resolveAgyExecutable } from "../runtime/version.ts";

export const DEFAULT_AGY_PLUGIN_DIR = fileURLToPath(new URL("../plugin", import.meta.url));

export function resolveMcpEntrypoint(): { nodePath: string; entrypointPath: string } {
  return {
    nodePath: process.execPath,
    entrypointPath: fileURLToPath(new URL("../mcp/index.js", import.meta.url)),
  };
}

export function generateMcpConfig(): {
  mcpServers: {
    pi: {
      command: string;
      args: string[];
    };
  };
} {
  return {
    mcpServers: {
      pi: {
        command: "sh",
        args: ["-c", "exec $PI_AGY_BRIDGE_MCP_COMMAND"],
      },
    },
  };
}

export async function ensureAgyPluginInstalled(
  agyPath?: string,
  pluginDir: string = DEFAULT_AGY_PLUGIN_DIR
): Promise<void> {
  const sourceDir = path.resolve(pluginDir);
  const sourceManifest = await readPluginManifest(path.join(sourceDir, "plugin.json"));
  if (!sourceManifest) throw new Error(`AGY plugin manifest not found: ${sourceDir}`);

  const targetDir = path.join(os.homedir(), ".gemini", "config", "plugins", sourceManifest.name);
  const installedManifest = await readPluginManifest(path.join(targetDir, "plugin.json"));
  const expectedConfigStr = JSON.stringify(generateMcpConfig(), null, 2);

  let currentConfigStr: string | null = null;
  try {
    currentConfigStr = await fs.readFile(path.join(targetDir, "mcp_config.json"), "utf-8");
  } catch {
    // not found or unreadable
  }

  if (installedManifest?.version === sourceManifest.version && currentConfigStr === expectedConfigStr) {
    return;
  }

  if (!installedManifest) {
    await installWithAgy(resolveAgyExecutable(agyPath), sourceDir);
  }

  await synchronizePlugin(sourceDir, targetDir);
  debugLog(
    "plugin",
    installedManifest
      ? `AGY plugin "${sourceManifest.name}" updated to ${sourceManifest.version} in ${targetDir}`
      : `AGY plugin "${sourceManifest.name}" installed at ${targetDir}`
  );
}

async function installWithAgy(executable: string, sourceDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["plugin", "install", sourceDir], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`agy plugin install failed (code ${code}, signal ${signal}): ${stderr.trim()}`));
    });
  });
}

async function synchronizePlugin(sourceDir: string, targetDir: string): Promise<void> {
  const temporaryDir = `${targetDir}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.mkdir(path.dirname(targetDir), { recursive: true });

  try {
    await fs.cp(sourceDir, temporaryDir, { recursive: true });
    const effectiveMcpConfig = generateMcpConfig();
    await fs.writeFile(
      path.join(temporaryDir, "mcp_config.json"),
      JSON.stringify(effectiveMcpConfig, null, 2)
    );
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.rename(temporaryDir, targetDir);
  } catch (error) {
    await fs.rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function readPluginManifest(filePath: string): Promise<{ name: string; version: string } | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(filePath, "utf-8"));
    if (!isRecord(value) || typeof value.name !== "string" || typeof value.version !== "string") {
      throw new Error(`Invalid AGY plugin manifest: ${filePath}`);
    }
    return { name: value.name, version: value.version };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
