import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import { parseModelsOutput, DEFAULT_AGY_MODELS, discoverAgyModels } from "../models.ts";

describe("parseModelsOutput", () => {
  const tableCases = [
    {
      name: "parses CLI table with space separated columns and collapses effort suffixes",
      input: `
gemini-3.8-flash-high     Gemini 3.8 Flash (High)
gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)
`,
      expectedLength: 2,
      verify: (models: any[]) => {
        assert.equal(models[0]?.id, "gemini-3.8-flash");
        assert.equal(models[0]?.name, "Gemini 3.8 Flash");
        assert.equal(models[0]?.thinkingLevelMap?.high, "high");
        assert.deepEqual(models[0]?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        assert.equal(models[1]?.id, "claude-sonnet-4-6");
        assert.equal(models[1]?.name, "Claude Sonnet 4.6 (Thinking)");
      },
    },
    {
      name: "parses markdown pipe tables and strips headers and divider lines",
      input: `
| Slug | Label |
| --- | --- |
| gemini-3.7-flash-high | Gemini 3.7 Flash (High) |
| gpt-oss-120b-medium | GPT-OSS 120B (Medium) |
`,
      expectedLength: 2,
      verify: (models: any[]) => {
        assert.equal(models[0]?.id, "gemini-3.7-flash");
        assert.equal(models[0]?.name, "Gemini 3.7 Flash");
        assert.equal(models[1]?.id, "gpt-oss-120b-medium");
      },
    },
    {
      name: "cleans terminal spinner characters and progress text",
      input: `
⠋ Fetching available models...⠙ Fetching available models...gemini-3.8-flash-high     Gemini 3.8 Flash (High)
gemini-3.1-pro-high       Gemini 3.1 Pro (High)
`,
      expectedLength: 2,
      verify: (models: any[]) => {
        assert.equal(models[0]?.id, "gemini-3.8-flash");
        assert.equal(models[1]?.id, "gemini-3.1-pro");
      },
    },
    {
      name: "handles empty output by returning empty array",
      input: "",
      expectedLength: 0,
      verify: (models: any[]) => {
        assert.deepEqual(models, []);
      },
    },
    {
      name: "handles invalid divider-only output by returning empty array",
      input: "   \n\n  ---  \n  ",
      expectedLength: 0,
      verify: (models: any[]) => {
        assert.deepEqual(models, []);
      },
    },
  ];

  it("parses supported output shapes and handles empty output", () => {
    for (const tc of tableCases) {
      const models = parseModelsOutput(tc.input);
      assert.equal(models.length, tc.expectedLength, tc.name);
      tc.verify(models);
    }
  });

  it("provides valid zero-cost defaults and uses them when discovery fails", async () => {
    assert.equal(DEFAULT_AGY_MODELS.length >= 5, true);
    for (const model of DEFAULT_AGY_MODELS) {
      assert.ok(model.id);
      assert.ok(model.name);
      assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
    assert.deepEqual(await discoverAgyModels("__invalid_binary_name__"), DEFAULT_AGY_MODELS);
  });
});
