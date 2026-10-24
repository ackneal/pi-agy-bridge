import { modelDefaults, UNSUPPORTED_THINKING_LEVELS } from "./model-metadata.ts";
import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import type { AnyModel, Api, Model } from "@earendil-works/pi-ai";
import { debugLog } from "../shared/debug.ts";
import { resolveAgyExecutable } from "../runtime/version.ts";

const execFileAsync = promisify(execFile);

export function restoreStoredAgyModels(models: readonly AnyModel[]): Model<Api>[] {
  return models
    .filter((model): model is Model<Api> =>
      model != null && typeof model === "object" &&
      model.provider === "agy" && (model.type === undefined || model.type === "chat") &&
      typeof model.id === "string" && model.id.trim().length > 0 &&
      typeof model.name === "string" && model.name.trim().length > 0 &&
      typeof model.reasoning === "boolean" &&
      typeof model.api === "string" && typeof model.baseUrl === "string" &&
      Array.isArray(model.input) && model.input.length > 0 &&
      model.input.every((input) => input === "text" || input === "image") &&
      model.cost != null &&
      [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite]
        .every((cost) => typeof cost === "number" && Number.isFinite(cost) && cost >= 0) &&
      "contextWindow" in model && Number.isFinite(model.contextWindow) && model.contextWindow > 0 &&
      "maxTokens" in model && Number.isFinite(model.maxTokens) && model.maxTokens > 0
    )
    .map((model) => ({
      ...model,
      ...modelDefaults(model.id),
      thinkingLevelMap: { ...UNSUPPORTED_THINKING_LEVELS, ...model.thinkingLevelMap },
    }));
}

export function parseModelsOutput(output: string): Model<Api>[] {
  const cleaned = stripVTControlCharacters(output);
  const rawLines = cleaned.split(/[\r\n]+/);
  const rows: { id: string; name: string }[] = [];
  const seenIds = new Set<string>();
  const models: Model<Api>[] = [];
  const modelsById = new Map<string, Model<Api>>();

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
        ...modelDefaults(modelId),
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
): Promise<Model<Api>[]> {
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
    throw new Error(`Failed to discover Antigravity CLI models via "${resolvedPath} models"`, { cause: err });
  }

  const models = parseModelsOutput(output);
  if (models.length === 0) {
    throw new Error(`Antigravity CLI returned no models from "${resolvedPath} models"`);
  }

  debugLog("models", `Discovered ${models.length} models from "${resolvedPath} models"`);
  return models;
}
