import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { debugLog } from "../shared/debug.ts";
import { resolveAgyExecutable } from "../runtime/version.ts";

const execFileAsync = promisify(execFile);
export const MODEL_CACHE_PATH = path.join(os.homedir(), ".pi", "agent", "cache", "agy-models.json");
const MODEL_METADATA = JSON.parse(
  readFileSync(new URL("./model.json", import.meta.url), "utf-8")
) as {
  default: { contextWindow: number };
  families: Record<string, { contextWindow: number }>;
};

function contextWindowFor(modelId: string): number {
  for (const [prefix, metadata] of Object.entries(MODEL_METADATA.families)) {
    if (modelId.startsWith(prefix)) return metadata.contextWindow;
  }
  return MODEL_METADATA.default.contextWindow;
}

export function loadCachedAgyModels(): ProviderModelConfig[] {
  try {
    const models: unknown = JSON.parse(readFileSync(MODEL_CACHE_PATH, "utf-8"));
    if (!Array.isArray(models)) return [];
    return models
      .filter((model): model is ProviderModelConfig =>
        typeof model?.id === "string" && typeof model?.name === "string"
      )
      .map((model) => {
        const legacyThinking = model.id === "claude-opus-4-6" &&
          (model.thinkingLevelMap as Record<string, unknown> | undefined)?.thinking === "thinking";
        const id = legacyThinking ? `${model.id}-thinking` : model.id;
        const name = legacyThinking && !/\(Thinking\)\s*$/i.test(model.name)
          ? `${model.name} (Thinking)` : model.name;

        return {
          ...model,
          id,
          name,
          thinkingLevelMap: legacyThinking
            ? { ...UNSUPPORTED_THINKING_LEVELS }
            : { ...UNSUPPORTED_THINKING_LEVELS, ...model.thinkingLevelMap },
          contextWindow: contextWindowFor(id),
        };
      });
  } catch {
    return [];
  }
}

export async function cacheAgyModels(models: ProviderModelConfig[]): Promise<void> {
  await mkdir(path.dirname(MODEL_CACHE_PATH), { recursive: true });
  await writeFile(MODEL_CACHE_PATH, JSON.stringify(models), "utf-8");
}

const UNSUPPORTED_THINKING_LEVELS = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
  max: null,
};

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function parseModelsOutput(output: string): ProviderModelConfig[] {
  const cleaned = output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
  const rawLines = cleaned.split(/[\r\n]+/);
  const rows: { id: string; name: string }[] = [];
  const seenIds = new Set<string>();
  const models: ProviderModelConfig[] = [];
  const modelsById = new Map<string, ProviderModelConfig>();

  for (const rawLine of rawLines) {
    const match = rawLine.trim().match(/^([a-zA-Z0-9][-a-zA-Z0-9_.:/]*)(?: {2,}|\t+)\s*(\S.*)$/);
    if (!match) continue;

    const id = match[1]!;
    const name = match[2]!;
    const lowerId = id.toLowerCase();

    if (["slug", "model", "model id", "id", "name", "models", "description"].includes(lowerId)) {
      continue;
    }

    if (seenIds.has(id)) continue;
    seenIds.add(id);
    rows.push({ id, name });
  }

  for (const { id, name } of rows) {
    const nameLevel = name.match(/\(([^()]+)\)\s*$/)?.[1]?.trim();
    const idParts = id.split("-");
    const idLevel = idParts.at(-1);
    const hasLevelSuffix = nameLevel && Object.hasOwn(UNSUPPORTED_THINKING_LEVELS, nameLevel.toLowerCase()) &&
      idLevel?.toLowerCase() === nameLevel.toLowerCase();
    const modelId = hasLevelSuffix ? idParts.slice(0, -1).join("-") : id;
    let model = modelsById.get(modelId);

    if (!model) {
      const displayName = hasLevelSuffix ? name.replace(/\s*\([^()]+\)\s*$/, "") : name;
      model = {
        id: modelId,
        name: displayName,
        reasoning: /thinking|reasoning/i.test(`${id} ${name}`),
        thinkingLevelMap: { ...UNSUPPORTED_THINKING_LEVELS },
        input: ["text", "image"],
        cost: ZERO_COST,
        contextWindow: contextWindowFor(modelId),
        maxTokens: 16_384,
      };
      modelsById.set(modelId, model);
      models.push(model);
    }

    if (hasLevelSuffix && nameLevel) {
      model.reasoning = true;
      model.thinkingLevelMap = {
        ...UNSUPPORTED_THINKING_LEVELS,
        ...model.thinkingLevelMap,
        [nameLevel.toLowerCase()]: nameLevel.toLowerCase(),
      };
    }
  }

  return models;
}

export async function discoverAgyModels(
  agyPath: string = "agy",
  signal?: AbortSignal
): Promise<ProviderModelConfig[]> {
  const resolvedPath = resolveAgyExecutable(agyPath);

  let output = "";
  try {
    const { stdout, stderr } = await execFileAsync(resolvedPath, ["models"], {
      encoding: "utf-8",
      timeout: 30000,
      killSignal: "SIGKILL",
      signal,
    });
    output = (stdout || stderr || "").trim();
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error(`Failed to discover AGY models via "${resolvedPath} models"`, { cause: err });
  }

  const models = parseModelsOutput(output);
  if (models.length === 0) {
    throw new Error(`AGY returned no models from "${resolvedPath} models"`);
  }

  debugLog("models", `Discovered ${models.length} models from "${resolvedPath} models"`);
  return models;
}
