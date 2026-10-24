import { readFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";

type ModelMetadata = Pick<Model<Api>, "contextWindow" | "maxTokens" | "input" | "cost">;

const MODEL_METADATA = JSON.parse(
  readFileSync(new URL("./model.json", import.meta.url), "utf-8")
) as {
  default: ModelMetadata;
  families: Record<string, Partial<ModelMetadata>>;
  models: Record<string, Partial<ModelMetadata>>;
};

export const UNSUPPORTED_THINKING_LEVELS = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
  max: null,
};

export function defaultModelCatalog(): Model<Api>[] {
  return Object.keys(MODEL_METADATA.models).map((id) => ({
    ...modelDefaults(id), id, name: id, reasoning: false,
    thinkingLevelMap: { ...UNSUPPORTED_THINKING_LEVELS },
  }));
}

export function modelDefaults(id: string) {
  const family = Object.entries(MODEL_METADATA.families).find(([prefix]) => id.startsWith(prefix))?.[1];
  const metadata = { ...MODEL_METADATA.default, ...family, ...MODEL_METADATA.models[id] };

  return {
    provider: "agy",
    api: "agy" as Api,
    baseUrl: "agy",
    type: "chat" as const,
    input: [...metadata.input],
    cost: {
      ...metadata.cost,
      ...(metadata.cost.tiers ? { tiers: metadata.cost.tiers.map((tier) => ({ ...tier })) } : {}),
    },
    contextWindow: metadata.contextWindow,
    maxTokens: metadata.maxTokens,
  };
}

