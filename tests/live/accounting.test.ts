import assert from "node:assert/strict";
import { test } from "node:test";
import { expectedAccounting } from "./accounting.ts";

for (const row of [
  { name: "missing input is not evidence", raw: { outputTokens: 3 }, expected: undefined },
  { name: "invalid output is not evidence", raw: { inputTokens: 2, outputTokens: NaN }, expected: undefined },
  { name: "negative input is not evidence", raw: { inputTokens: -1, outputTokens: 3 }, expected: undefined },
  { name: "zero usage is valid", raw: { inputTokens: 0, outputTokens: 0 }, expected: [0, 0, 0, 0, undefined, 0] },
  { name: "cache is included in input", raw: { inputTokens: 100, outputTokens: 8, cachedReadTokens: 20, cachedWriteTokens: 10 }, expected: [70, 8, 20, 10, undefined, 108] },
  { name: "thoughts already included", raw: { inputTokens: 100, outputTokens: 8, thoughtTokens: 3, totalTokens: 108 }, expected: [100, 8, 0, 0, 3, 108] },
  { name: "total proves separate thoughts", raw: { inputTokens: 100, outputTokens: 8, thoughtTokens: 3, totalTokens: 111 }, expected: [100, 11, 0, 0, 3, 111] },
  { name: "no total cannot prove separate thoughts", raw: { inputTokens: 100, outputTokens: 8, thoughtTokens: 3 }, expected: [100, 8, 0, 0, 3, 108] },
  { name: "invalid optional counters ignored", raw: { inputTokens: 10, outputTokens: 2, cachedReadTokens: -1, cachedWriteTokens: Infinity, thoughtTokens: NaN }, expected: [10, 2, 0, 0, undefined, 12] },
  { name: "excess cache clamps uncached input", raw: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 20 }, expected: [0, 2, 20, 0, undefined, 22] },
]) {
  test(`live accounting oracle: ${row.name}`, () => {
    const result = expectedAccounting(row.raw);
    assert.deepEqual(result && [result.input, result.output, result.cacheRead, result.cacheWrite, result.reasoning, result.totalTokens], row.expected);
    if (result) assert.deepEqual(result.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  });
}
