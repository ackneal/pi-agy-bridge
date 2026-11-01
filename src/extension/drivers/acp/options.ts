import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import fs from "node:fs";
import path from "node:path";
import { prepareDriverCwd } from "../cwd.ts";
import type { ConnectionOptions } from "./connection.ts";

function isExecutableFile(filepath: string): boolean {
  try {
    if (!fs.statSync(filepath).isFile()) return false;
    fs.accessSync(filepath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function detectExecutable(): string | undefined {
  const directory = process.env.AGY_ACP_DIR;
  if (!directory?.trim() || !path.isAbsolute(directory)) return undefined;

  try {
    if (!fs.statSync(directory).isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  const executable = path.join(directory, "agy_acp_server.par");
  const helper = path.join(directory, "localharness_external");
  return isExecutableFile(executable) && isExecutableFile(helper) ? executable : undefined;
}

export function resolveEffort(model: Model<any>, options: SimpleStreamOptions | undefined): string | undefined {
  const selection = options as (SimpleStreamOptions & { reasoningEffort?: unknown; thinkingLevel?: unknown }) | undefined;
  const effort = selection?.reasoningEffort ?? selection?.reasoning ?? selection?.thinkingLevel;
  if (effort === undefined) return undefined;
  if (effort !== "low" && effort !== "medium" && effort !== "high") throw new Error(`Unsupported ACP thinking_level: ${String(effort)}`);
  if (model.thinkingLevelMap?.[effort] === null) throw new Error(`Unsupported ACP thinking_level for ${model.id}: ${effort}`);
  return effort;
}

export function resolveConnectionOptions(executable?: string): ConnectionOptions {
  if (!executable?.trim()) throw new Error("Antigravity ACP executable not found; retry ACP preparation or set AGY_ACP_DIR");

  return { executable, cwd: prepareDriverCwd("acp"), ...(process.platform === "linux" ? { args: ["--uid="] } : {}) };
}
