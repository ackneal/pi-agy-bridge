import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { describe, it } from "node:test";
import { discoverAgyModels, loadCachedAgyModels, MODEL_CACHE_PATH, parseModelsOutput } from "./models.ts";

const unsupported = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null };

describe("AGY model discovery", () => {
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
    it(`normalizes cached maps without inventing capabilities: ${JSON.stringify(map)}`, (t) => {
      const cached = [{ id: "model", name: "Model", reasoning: true, ...(map === undefined ? {} : { thinkingLevelMap: map }) }];
      const originalRead = fs.readFileSync;
      t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
        if (args[0] === MODEL_CACHE_PATH) return JSON.stringify(cached);
        return originalRead(...args);
      });

      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });

      const [model] = loadCachedAgyModels();

      assert.deepEqual(model?.thinkingLevelMap, { ...unsupported, ...map });

    });
  }

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

  for (const name of ["Claude Opus 4.6", "Claude Opus 4.6 (Thinking)"]) {
    it(`repairs legacy fixed Thinking cache: ${name}`, (t) => {
      const originalRead = fs.readFileSync;
      t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
        if (args[0] === MODEL_CACHE_PATH) return JSON.stringify([{
          id: "claude-opus-4-6", name, reasoning: true, thinkingLevelMap: { thinking: "thinking" },
        }]);
        return originalRead(...args);
      });
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });

      const [model] = loadCachedAgyModels();

      assert.equal(model?.id, "claude-opus-4-6-thinking");
      assert.equal(model?.name, "Claude Opus 4.6 (Thinking)");
      assert.equal(model?.reasoning, true);
      assert.deepEqual(model?.thinkingLevelMap, unsupported);
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
    assert.deepEqual(models[0]?.thinkingLevelMap, { ...unsupported, high: "high" });
    assert.deepEqual(parseModelsOutput("\n---\n"), []);
  });

  it("fails discovery when AGY is unavailable instead of returning fallback models", async () => {
    await assert.rejects(
      discoverAgyModels("__invalid_binary_name__"),
      /Failed to discover AGY models/
    );
  });
});
