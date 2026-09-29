import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_AGY_MODELS } from "../models.ts";

describe("DEFAULT_AGY_MODELS", () => {
  it("provides unique, zero-cost model definitions", () => {
    assert.ok(DEFAULT_AGY_MODELS.length > 0);
    assert.equal(new Set(DEFAULT_AGY_MODELS.map((model) => model.id)).size, DEFAULT_AGY_MODELS.length);

    for (const model of DEFAULT_AGY_MODELS) {
      assert.ok(model.id);
      assert.ok(model.name);
      assert.ok(model.contextWindow > 0);
      assert.ok(model.maxTokens > 0);
      assert.deepEqual(model.cost, {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
    }
  });
});
