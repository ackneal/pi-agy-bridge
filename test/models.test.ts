import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverAgyModels, parseModelsOutput } from "../src/models.ts";

describe("AGY model discovery", () => {
  it("parses model rows without replacing discovered model IDs", () => {
    const models = parseModelsOutput(`
| Slug | Label |
| --- | --- |
| gemini-3.8-flash-high | Gemini 3.8 Flash (High) |
| gemini-3.8-flash-medium | Gemini 3.8 Flash (Medium) |
| claude-sonnet-4-6 | Claude Sonnet 4.6 (Thinking) |
| gpt-oss-120b-medium | GPT OSS 120B (Medium) |
| other-model-low | Other Model (Low) |
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

  it("ignores progress, headers, dividers, duplicates, and empty output", () => {
    const models = parseModelsOutput(`
⠋ Fetching available models...gemini-x-high  Gemini X (High)
| Slug | Label |
| --- | --- |
gemini-x-high  Duplicate
`);

    assert.deepEqual(models.map((model) => model.id), ["gemini-x"]);
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
