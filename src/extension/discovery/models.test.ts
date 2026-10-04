import assert from "node:assert/strict";
import { calculateCost, type Usage, type AnyModel } from "@earendil-works/pi-ai";
import { describe, it } from "node:test";
import { discoverAgyModels, restoreStoredAgyModels, parseModelsOutput } from "./models.ts";

const proIds = ["gemini-3.1-pro", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools"];
const proCost = {
  input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0,
  tiers: [{ inputTokensAbove: 200_000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 0 }],
};
const flashCost = { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 };
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const unsupported = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null };

describe("Antigravity CLI model discovery", () => {
  for (const { id, maxTokens, cost } of [
    { id: "gemini-3.8-flash", maxTokens: 65_536, cost: flashCost },
    { id: "gemini-3.7-flash", maxTokens: 65_536, cost: flashCost },
    { id: "gemini-3.6-flash", maxTokens: 65_536, cost: flashCost },
    { id: "gemini-3.1-pro", maxTokens: 65_536, cost: proCost },
    { id: "gemini-3.1-pro-preview", maxTokens: 65_536, cost: proCost },
    { id: "gemini-3.1-pro-preview-customtools", maxTokens: 65_536, cost: proCost },
    { id: "gemini-new-flash", maxTokens: 16_384, cost: zeroCost },
    { id: "gemini-3.8-flash-preview", maxTokens: 16_384, cost: zeroCost },
  ]) {
    it(`applies metadata after effort normalization: ${id}`, () => {
      const [model] = parseModelsOutput(`${id}-high  Gemini (High)`);

      assert.equal(model?.id, id);
      assert.equal(model?.contextWindow, 1_048_576);
      assert.equal(model?.maxTokens, maxTokens);
      assert.deepEqual(model?.cost, cost);
      assert.deepEqual(model?.thinkingLevelMap, { ...unsupported, high: "high" });
    });

    it(`replaces stale cached metadata: ${id}`, () => {
      const [original] = parseModelsOutput(`${id}-high  Gemini (High)`);
      const stored = { ...original!, contextWindow: 1, maxTokens: 2,
        cost: { input: 99, output: 98, cacheRead: 97, cacheWrite: 96,
          tiers: [{ inputTokensAbove: 1, input: 95, output: 94, cacheRead: 93, cacheWrite: 92 }] } };

      const [model] = restoreStoredAgyModels([stored]);

      assert.equal(model?.id, id);
      assert.equal(model?.contextWindow, 1_048_576);
      assert.equal(model?.maxTokens, maxTokens);
      assert.deepEqual(model?.cost, cost);
      assert.deepEqual(model?.thinkingLevelMap, original?.thinkingLevelMap);
      assert.equal(stored.maxTokens, 2);
      assert.equal(stored.cost.input, 99);
      assert.equal(stored.cost.tiers[0]?.inputTokensAbove, 1);
    });
  }

  for (const id of proIds) {
    for (const prompt of [199_999, 200_000, 200_001]) {
      for (const { label, cacheRead, cacheWrite } of [
        { label: "uncached", cacheRead: 0, cacheWrite: 0 },
        { label: "cache reads", cacheRead: 100_000, cacheWrite: 0 },
        { label: "cache reads and writes", cacheRead: 60_000, cacheWrite: 40_000 },
      ]) {
        it(`uses native request-wide pricing: ${id}, prompt ${prompt}, ${label}`, () => {
          const [model] = parseModelsOutput(`${id}-high  Gemini (High)`);
          const usage: Usage = {
            input: prompt - cacheRead - cacheWrite, output: 1_000, cacheRead, cacheWrite,
            totalTokens: prompt + 1_000,
            cost: { ...zeroCost, total: 0 },
          };
          const rates = prompt > 200_000 ? proCost.tiers[0]! : proCost;
          const expected = {
            input: (rates.input / 1_000_000) * usage.input,
            output: (rates.output / 1_000_000) * usage.output,
            cacheRead: (rates.cacheRead / 1_000_000) * cacheRead,
            cacheWrite: 0,
          };

          const cost = calculateCost(model!, usage);

          assert.deepEqual(cost, {
            ...expected, total: expected.input + expected.output + expected.cacheRead,
          });
          assert.equal(usage.cost, cost);
        });
      }
    }
  }

  for (const levels of [[], ["low"], ["low", "medium", "high"], ["off", "minimal", "xhigh", "max"]]) {
    it(`normalizes declared suffix levels: ${levels.join(", ") || "none"}`, () => {
      const output = levels.length
        ? levels.map((level) => `model-${level}  Model (${level})`).join("\n")
        : "plain-model  Model";
      const [model] = parseModelsOutput(output);

      assert.deepEqual(model?.thinkingLevelMap, levels.length
        ? { ...unsupported, ...Object.fromEntries(levels.map((level) => [level, level])) }
        : unsupported);
    });
  }

  for (const map of [undefined, {}, { low: "custom-low", medium: "medium", high: "high", off: null }]) {
    it(`restores stored maps without inventing levels: ${JSON.stringify(map)}`, () => {
      const [original] = parseModelsOutput("unknown-model  Model");
      const { thinkingLevelMap: _map, ...fields } = original!;
      const stored = { ...fields, api: "old-api", baseUrl: "old-url", contextWindow: 1, maxTokens: 1, ...(map === undefined ? {} : { thinkingLevelMap: map }) };
      const [model] = restoreStoredAgyModels([stored]);

      assert.deepEqual(model, { ...original, thinkingLevelMap: { ...unsupported, ...map } });
      assert.equal(stored.contextWindow, 1);
    });
  }

  for (const patch of [
    { provider: "other" }, { type: "image" }, { id: "" }, { name: "" },
    { reasoning: undefined }, { api: undefined }, { baseUrl: undefined },
    { input: [] }, { cost: undefined }, { contextWindow: NaN }, { maxTokens: 0 },
  ]) {
    it(`rejects invalid stored models: ${JSON.stringify(patch)}`, () => {
      const [model] = parseModelsOutput("model  Model");
      const stored = { ...model, ...patch } as AnyModel;

      assert.deepEqual(restoreStoredAgyModels([stored]), []);
    });
  }

  it("restores implicit chat models without renaming fixed Thinking IDs", () => {
    const [model] = parseModelsOutput("claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)");

    const { type: _type, ...stored } = model!;

    assert.deepEqual(restoreStoredAgyModels([stored]), [model]);
  });

  for (const { id, name, expectedId, expectedName } of [
    { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", expectedId: "claude-opus-4-6-thinking", expectedName: "Claude Opus 4.6 (Thinking)" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)", expectedId: "claude-sonnet-4-6", expectedName: "Claude Sonnet 4.6 (Thinking)" },
    { id: "model-unknown", name: "Model (Unknown)", expectedId: "model-unknown", expectedName: "Model (Unknown)" },
  ]) {
    it(`preserves non-effort suffix: ${id}`, () => {
      const [model] = parseModelsOutput(`${id}  ${name}`);

      assert.equal(model?.id, expectedId);
      assert.equal(model?.name, expectedName);
      assert.deepEqual(model?.thinkingLevelMap, unsupported);
      assert.equal(model?.reasoning, /thinking/i.test(name));
    });
  }

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
    assert.deepEqual(models[0]?.thinkingLevelMap, { ...unsupported, high: "high", medium: "medium" });
    assert.equal(models[0]?.contextWindow, 1_048_576);
    assert.equal(models[1]?.reasoning, true);
    assert.equal(models[1]?.contextWindow, 250_000);
    assert.equal(models[2]?.contextWindow, 131_072);
    assert.deepEqual(models[3]?.thinkingLevelMap, { ...unsupported, low: "low" });
    assert.equal(models[3]?.contextWindow, 272_000);
    for (const model of models) {
      assert.deepEqual(model.cost, proIds.includes(model.id) ? proCost : /^gemini-3\.[678]-flash$/.test(model.id) ? flashCost : zeroCost);
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
      "claude-opus-4-6-thinking",
      "gpt-oss-120b",
    ]);

    const byId = new Map(models.map((model) => [model.id, model]));
    assert.deepEqual(byId.get("gemini-3.8-flash")?.thinkingLevelMap, { ...unsupported, high: "high", medium: "medium", low: "low" });
    assert.deepEqual(byId.get("gemini-3.1-pro")?.thinkingLevelMap, { ...unsupported, high: "high", low: "low" });
    assert.deepEqual(byId.get("gpt-oss-120b")?.thinkingLevelMap, { ...unsupported, medium: "medium" });
    assert.equal(byId.get("claude-sonnet-4-6")?.name, "Claude Sonnet 4.6 (Thinking)");
    assert.deepEqual(byId.get("claude-sonnet-4-6")?.thinkingLevelMap, unsupported);
    assert.equal(byId.get("claude-opus-4-6-thinking")?.name, "Claude Opus 4.6 (Thinking)");
    assert.deepEqual(byId.get("claude-opus-4-6-thinking")?.thinkingLevelMap, unsupported);
    assert.equal(byId.get("gemini-3.8-flash")?.contextWindow, 1_048_576);
    assert.equal(byId.get("claude-sonnet-4-6")?.contextWindow, 250_000);
    assert.equal(byId.get("gpt-oss-120b")?.contextWindow, 131_072);
    for (const model of models) {
      assert.equal(model.provider, "agy");
      assert.equal(model.api, "agy");
      assert.equal(model.baseUrl, "agy");
      assert.equal(model.type, "chat");
      assert.equal(model.maxTokens, model.id.startsWith("gemini-") ? 65_536 : 16_384);
      assert.deepEqual(model.input, ["text", "image"]);
      assert.equal(typeof model.name, "string");
      assert.equal(model.reasoning, true);
      assert.deepEqual(model.cost, proIds.includes(model.id) ? proCost : /^gemini-3\.[678]-flash$/.test(model.id) ? flashCost : zeroCost);
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
    assert.deepEqual(models[0]?.thinkingLevelMap, { ...unsupported, high: "high" });
    assert.deepEqual(parseModelsOutput("\n---\n"), []);
  });

  it("fails discovery when Antigravity CLI is unavailable instead of returning fallback models", async () => {
    await assert.rejects(
      discoverAgyModels("__invalid_binary_name__"),
      /Failed to discover Antigravity CLI models/
    );
  });
});
