import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverAgyModels, parseModelsOutput } from "./models.ts";

describe("AGY model discovery", () => {
  it("parses model rows without replacing discovered model IDs", () => {
    const models = parseModelsOutput(`
gemini-3.8-flash-high    Gemini 3.8 Flash (High)
gemini-3.8-flash-medium  Gemini 3.8 Flash (Medium)
claude-sonnet-4-6       Claude Sonnet 4.6 (Thinking)
gpt-oss-120b-medium     GPT OSS 120B (Medium)
other-model-low        Other Model (Low)
`);

    assert.deepEqual(models.map((model) => model.id), [
      "gemini-3.8-flash",
      "claude-sonnet-4-6",
      "gpt-oss-120b",
      "other-model",
    ]);
    assert.equal(models[0]?.name, "Gemini 3.8 Flash");
    assert.equal(models[0]?.reasoning, true);
    assert.deepEqual(models[0]?.thinkingLevelMap, { high: "high", medium: "medium" });
    assert.equal(models[0]?.contextWindow, 1_048_576);
    assert.equal(models[1]?.reasoning, true);
    assert.equal(models[1]?.contextWindow, 250_000);
    assert.equal(models[2]?.contextWindow, 131_072);
    assert.deepEqual(models[3]?.thinkingLevelMap, { low: "low" });
    assert.equal(models[3]?.contextWindow, 272_000);
    for (const model of models) {
      assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
  });

  it("parses the real agy models table (captured from agy 1.2.14)", () => {
    const models = parseModelsOutput(`
gemini-3.8-flash-high     Gemini 3.8 Flash (High)
gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)
gemini-3.8-flash-low      Gemini 3.8 Flash (Low)
gemini-3.7-flash-high     Gemini 3.7 Flash (High)
gemini-3.7-flash-medium   Gemini 3.7 Flash (Medium)
gemini-3.7-flash-low      Gemini 3.7 Flash (Low)
gemini-3.6-flash-high     Gemini 3.6 Flash (High)
gemini-3.6-flash-medium   Gemini 3.6 Flash (Medium)
gemini-3.6-flash-low      Gemini 3.6 Flash (Low)
gemini-3.1-pro-high       Gemini 3.1 Pro (High)
gemini-3.1-pro-low        Gemini 3.1 Pro (Low)
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)
gpt-oss-120b-medium       GPT-OSS 120B (Medium)
`);

    assert.deepEqual(models.map((model) => model.id), [
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.1-pro",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "gpt-oss-120b",
    ]);

    const byId = new Map(models.map((model) => [model.id, model]));
    assert.deepEqual(byId.get("gemini-3.8-flash")?.thinkingLevelMap, { high: "high", medium: "medium", low: "low" });
    assert.deepEqual(byId.get("gemini-3.1-pro")?.thinkingLevelMap, { high: "high", low: "low" });
    assert.deepEqual(byId.get("gpt-oss-120b")?.thinkingLevelMap, { medium: "medium" });
    assert.equal(byId.get("claude-sonnet-4-6")?.name, "Claude Sonnet 4.6 (Thinking)");
    assert.equal(byId.get("claude-sonnet-4-6")?.thinkingLevelMap, undefined);
    assert.equal(byId.get("claude-opus-4-6")?.name, "Claude Opus 4.6");
    assert.deepEqual(byId.get("claude-opus-4-6")?.thinkingLevelMap, { thinking: "thinking" });
    assert.equal(byId.get("gemini-3.8-flash")?.contextWindow, 1_048_576);
    assert.equal(byId.get("claude-sonnet-4-6")?.contextWindow, 250_000);
    assert.equal(byId.get("gpt-oss-120b")?.contextWindow, 131_072);
    for (const model of models) {
      assert.equal(model.reasoning, true);
      assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
  });

  it("ignores progress, headers, dividers, duplicates, and empty output", () => {
    const models = parseModelsOutput(`
⠋ Fetching available models...gemini-x-high  Gemini X (High)
Fetching available models...
Slug  Label
| Slug | Label |
| --- | --- |
gemini-x-high\tGemini X (High)
gemini-x-high  Duplicate
invalid-single-space Invalid Model
missing-name
\u001b[32mgemini-y-low  Gemini Y (Low)\u001b[0m
`);

    assert.deepEqual(models.map((model) => model.id), ["gemini-x", "gemini-y"]);
    assert.deepEqual(models[0]?.thinkingLevelMap, { high: "high" });
    assert.deepEqual(parseModelsOutput("\n---\n"), []);
  });

  it("fails discovery when AGY is unavailable instead of returning fallback models", async () => {
    await assert.rejects(
      discoverAgyModels("__invalid_binary_name__"),
      /Failed to discover AGY models/
    );
  });
});
