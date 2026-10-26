import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome } from "../../shared/paths.ts";
import type { AcpConnectionOptions } from "./connection.ts";

function isExecutableFile(filepath: string): boolean {
  try {
    if (!fs.statSync(filepath).isFile()) return false;
    fs.accessSync(filepath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function detectAcpExecutable(customPath?: string): string | undefined {
  if (customPath?.trim()) {
    const expanded = path.resolve(expandHome(customPath));
    if (isExecutableFile(expanded)) return expanded;
    return undefined;
  }

  const fromEnv = process.env.AGY_ACP_BIN;
  if (fromEnv?.trim()) {
    const expanded = path.resolve(expandHome(fromEnv));
    if (isExecutableFile(expanded)) return expanded;
  }

  const optDir = path.join(os.homedir(), ".local", "opt", "agy-acp");
  if (fs.existsSync(optDir)) {
    try {
      const entries = fs.readdirSync(optDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const par = path.join(optDir, entry.name, "agy_acp_server.par");
          if (isExecutableFile(par)) return par;
          const bin = path.join(optDir, entry.name, "agy_acp_server");
          if (isExecutableFile(bin)) return bin;
        } else if ((entry.name === "agy_acp_server.par" || entry.name === "agy_acp_server") && isExecutableFile(path.join(optDir, entry.name))) {
          return path.join(optDir, entry.name);
        }
      }
    } catch {
      // Ignore filesystem inspection errors
    }
  }

  const localBin = path.join(os.homedir(), ".local", "bin", "agy_acp_server");
  if (isExecutableFile(localBin)) return localBin;

  return undefined;
}

export function resolveAcpEffort(model: Model<any>, options: SimpleStreamOptions | undefined): string | undefined {
  const selection = options as (SimpleStreamOptions & { reasoningEffort?: unknown; thinkingLevel?: unknown }) | undefined;
  const effort = selection?.reasoningEffort ?? selection?.reasoning ?? selection?.thinkingLevel;
  if (effort === undefined) return undefined;
  if (effort !== "low" && effort !== "medium" && effort !== "high") throw new Error(`Unsupported ACP thinking_level: ${String(effort)}`);
  if (model.thinkingLevelMap?.[effort] === null) throw new Error(`Unsupported ACP thinking_level for ${model.id}: ${effort}`);
  return effort;
}

export function resolveAcpConnectionOptions(cwd: string, executable?: string): AcpConnectionOptions {
  if (!executable?.trim()) throw new Error("Antigravity ACP executable not found; please install agy-acp or set AGY_ACP_BIN");

  return { executable, cwd: path.resolve(cwd) };
}
