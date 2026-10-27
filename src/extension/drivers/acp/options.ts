import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import fs from "node:fs";
import path from "node:path";
import { prepareDriverCwd } from "../cwd.ts";
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

export function resolveAcpConnectionOptions(executable?: string): AcpConnectionOptions {
  if (!executable?.trim()) throw new Error("Antigravity ACP executable not found; retry ACP preparation or set AGY_ACP_BIN");

  return { executable, cwd: prepareDriverCwd("acp"), ...(process.platform === "linux" ? { args: ["--uid="] } : {}) };
}
