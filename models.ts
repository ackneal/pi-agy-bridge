import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const FLASH_THINKING_LEVEL_MAP = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: null,
};

const PRO_THINKING_LEVEL_MAP = {
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

