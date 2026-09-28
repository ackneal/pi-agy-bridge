import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { debugLog } from "./debug.ts";
import { resolveAgyExecutable } from "./version.ts";

const execFileAsync = promisify(execFile);

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const FLASH_THINKING_LEVEL_MAP = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: null,
};

export const PRO_THINKING_LEVEL_MAP = {
  off: null,
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: null,
};

export const DEFAULT_AGY_MODELS: ProviderModelConfig[] = [
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    reasoning: true,
    thinkingLevelMap: FLASH_THINKING_LEVEL_MAP,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    reasoning: true,
    thinkingLevelMap: FLASH_THINKING_LEVEL_MAP,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    reasoning: true,
    thinkingLevelMap: FLASH_THINKING_LEVEL_MAP,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    reasoning: true,
    thinkingLevelMap: PRO_THINKING_LEVEL_MAP,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    reasoning: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    id: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 (Thinking)",
    reasoning: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    id: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B",
    reasoning: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
];

export function parseModelsOutput(output: string): ProviderModelConfig[] {
  const cleaned = output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
  const rawLines = cleaned.split(/[\r\n]+/);
  const models: ProviderModelConfig[] = [];
  const seenIds = new Set<string>();

  for (let rawLine of rawLines) {
    rawLine = rawLine.trim();
    if (!rawLine) continue;

    const lastFetch = rawLine.lastIndexOf("Fetching available models...");
    if (lastFetch !== -1) {
      rawLine = rawLine.slice(lastFetch + "Fetching available models...".length).trim();
    }
    rawLine = rawLine.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]+/g, "").trim();
    if (!rawLine || /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(rawLine) || rawLine.includes("Fetching available models")) {
      continue;
    }

    if (rawLine.startsWith("|") && rawLine.endsWith("|")) {
      rawLine = rawLine.slice(1, -1).trim();
    }

    if (/^[-\s|:=+]+$/.test(rawLine)) {
      continue;
    }

    let parts: string[];
    if (rawLine.includes("|")) {
      parts = rawLine.split("|").map((p) => p.trim()).filter(Boolean);
    } else {
      parts = rawLine.split(/\s{2,}|\t+/).map((p) => p.trim()).filter(Boolean);
      if (parts.length === 1) {
        const spaceIdx = rawLine.indexOf(" ");
        if (spaceIdx !== -1) {
          parts = [rawLine.slice(0, spaceIdx).trim(), rawLine.slice(spaceIdx + 1).trim()];
        }
      }
    }

    if (parts.length === 0) continue;

    const id = parts[0];
    if (!id) continue;
    const lowerId = id.toLowerCase();

    if (["slug", "model", "model id", "id", "name", "models", "description"].includes(lowerId)) {
      continue;
    }

    if (!/^[a-zA-Z0-9][-a-zA-Z0-9_.:/]*$/.test(id)) {
      continue;
    }

    let modelId = id;
    let displayName = parts[1] && parts[1].length > 0 ? parts[1] : id;
    let thinkingLevelMap: ProviderModelConfig["thinkingLevelMap"] = undefined;

    const effortMatch = id.match(/^(gemini-[^]+)-(high|medium|low)$/);
    if (effortMatch && effortMatch[1]) {
      modelId = effortMatch[1];
      displayName = displayName.replace(/\s*\((High|Medium|Low)\)\s*$/i, "").trim();
      thinkingLevelMap = FLASH_THINKING_LEVEL_MAP;
    }

    if (seenIds.has(modelId)) continue;
    seenIds.add(modelId);

    const known = DEFAULT_AGY_MODELS.find((m) => m.id === modelId);

    const isGemini = modelId.toLowerCase().includes("gemini");
    const isClaude = modelId.toLowerCase().includes("claude");

    models.push({
      id: modelId,
      name: displayName,
      reasoning: known?.reasoning ?? true,
      thinkingLevelMap: thinkingLevelMap ?? known?.thinkingLevelMap,
      input: known?.input ?? ["text", "image"],
      cost: ZERO_COST,
      contextWindow: known?.contextWindow ?? (isGemini ? 1_048_576 : 200_000),
      maxTokens: known?.maxTokens ?? (isGemini ? 65_536 : isClaude ? 8_192 : 16_384),
    });
  }

  return models;
}

export async function discoverAgyModels(agyPath: string = "agy"): Promise<ProviderModelConfig[]> {
  const resolvedPath = resolveAgyExecutable(agyPath);

  let output = "";
  try {
    const { stdout, stderr } = await execFileAsync(resolvedPath, ["models"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    output = (stdout || stderr || "").trim();
  } catch (err) {
    debugLog("models", `Failed to discover models via "${agyPath} models"; using default models:`, err);
    return DEFAULT_AGY_MODELS;
  }

  const models = parseModelsOutput(output);
  if (models.length > 0) {
    debugLog("models", `Discovered ${models.length} models from "${resolvedPath} models"`);
    return models;
  }

  debugLog("models", `No models parsed from "${resolvedPath} models" output; using default models`);
  return DEFAULT_AGY_MODELS;
}
