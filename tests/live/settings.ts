import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";

export function liveSettings(env: NodeJS.ProcessEnv = process.env): { model: string; effort: "low" | "medium" | "high" } {
  const model = env.PI_AGY_LIVE_MODEL ?? "gemini-3.8-flash";
  const effort = env.PI_AGY_LIVE_EFFORT ?? "low";
  assert.ok(model.trim(), "PI_AGY_LIVE_MODEL must not be empty");
  assert.ok(effort === "low" || effort === "medium" || effort === "high", "PI_AGY_LIVE_EFFORT must be low, medium or high");
  return { model, effort };
}

export function liveModel(env: NodeJS.ProcessEnv = process.env): Model<any> {
  return {
    id: liveSettings(env).model, name: "live", provider: "agy", api: "agy", baseUrl: "agy",
    reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}
