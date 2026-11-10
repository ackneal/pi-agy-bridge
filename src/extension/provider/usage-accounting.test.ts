import assert from "node:assert/strict";
import test from "node:test";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { estimateUsageCost, splitPromptUsage } from "./usage-accounting.ts";

function usage(input = 10, output = 5, cacheRead = 3, cacheWrite = 2, totalTokens = input + output + cacheRead + cacheWrite): Usage {
  return { input, output, cacheRead, cacheWrite, totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

for (const row of [
  { name: "effective Argon rates", rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
    record: usage(1000, 200, 300, 0), expected: { input: 0.004, output: 0.004, cacheRead: 0.00006, cacheWrite: 0 } },
  { name: "user override rates and cached input", rates: { input: 9, output: 10, cacheRead: 2, cacheWrite: 3 },
    record: { ...usage(1000, 200, 300, 400), reasoning: 100 },
    expected: { input: 0.009, output: 0.002, cacheRead: 0.0006, cacheWrite: 0.0012 } },
  { name: "unknown rates remain zero", rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    record: usage(), expected: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  { name: "context occupancy is not billable usage", rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
    record: usage(0, 0, 0, 0, 800), expected: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  { name: "native tiers include cached input at their boundary",
    rates: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0,
      tiers: [{ inputTokensAbove: 1000, input: 3, output: 4, cacheRead: 0.3, cacheWrite: 0 }] },
    record: usage(1000, 200, 1, 0), expected: { input: 0.003, output: 0.0008, cacheRead: 0.0000003, cacheWrite: 0 } },
] satisfies { name: string; rates: Model<"anthropic-messages">["cost"]; record: Usage; expected: Omit<Usage["cost"], "total"> }[]) {
  test(`estimateUsageCost: ${row.name}`, () => {
    const model: Model<"anthropic-messages"> = {
      id: "effective-model", name: "Effective model", api: "anthropic-messages", provider: "agy",
      baseUrl: "https://example.invalid", input: ["text"], reasoning: true,
      contextWindow: 1_048_576, maxTokens: 16384, cost: row.rates,
    };
    const before = structuredClone(row.record);
    Object.freeze(row.record.cost);
    Object.freeze(row.record);

    const actual = estimateUsageCost(model, row.record);

    assert.deepEqual({ ...actual, cost: row.record.cost }, row.record);
    const expectedCost = { ...row.expected,
      total: row.expected.input + row.expected.output + row.expected.cacheRead + row.expected.cacheWrite };
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
      assert.ok(Math.abs(actual.cost[field] - expectedCost[field]) < 1e-12, field);
    }
    assert.deepEqual(row.record, before);
    assert.notStrictEqual(actual, row.record);
    assert.notStrictEqual(actual.cost, row.record.cost);
  });
}

type Case = { name: string; arrange: () => { total: Usage; last: Usage; expected: Usage | undefined } };
const cases: Case[] = [
  { name: "actual two-call aggregate", arrange: () => ({
    total: usage(14490, 865, 0, 0, 15355), last: usage(8461, 734, 0, 0, 9195),
    expected: usage(6029, 131, 0, 0, 6160),
  }) },
  { name: "actual thirty-call aggregate", arrange: () => ({
    total: usage(123355, 6774, 887639, 0, 1017768), last: usage(3513, 1927, 58788, 0, 64228),
    expected: usage(119842, 4847, 828851, 0, 953540),
  }) },
  { name: "one call leaves zero remainder", arrange: () => ({
    total: usage(), last: usage(), expected: usage(0, 0, 0, 0),
  }) },
  { name: "all canonical costs split", arrange: () => ({
    total: { ...usage(), cost: { input: 8, output: 10, cacheRead: 6, cacheWrite: 4, total: 28 } },
    last: { ...usage(1, 1, 1, 1), cost: { input: 2, output: 3, cacheRead: 1, cacheWrite: 2, total: 8 } },
    expected: { ...usage(9, 4, 2, 1), cost: { input: 6, output: 7, cacheRead: 5, cacheWrite: 2, total: 20 } },
  }) },
  { name: "optional breakdowns split", arrange: () => ({
    total: { ...usage(), reasoning: 4, cacheWrite1h: 2 },
    last: { ...usage(1, 2, 1, 1), reasoning: 1, cacheWrite1h: 1 },
    expected: { ...usage(9, 3, 2, 1), reasoning: 3, cacheWrite1h: 1 },
  }) },
  { name: "missing last breakdowns count as zero", arrange: () => ({
    total: { ...usage(), reasoning: 4, cacheWrite1h: 2 }, last: usage(1, 1, 1, 1),
    expected: { ...usage(9, 4, 2, 1), reasoning: 4, cacheWrite1h: 2 },
  }) },
  { name: "missing total breakdowns allow explicit last zero", arrange: () => ({
    total: usage(), last: { ...usage(1, 1, 1, 1), reasoning: 0, cacheWrite1h: 0 },
    expected: { ...usage(9, 4, 2, 1), reasoning: 0, cacheWrite1h: 0 },
  }) },
  { name: "native totals can exceed component sums", arrange: () => ({
    total: usage(10, 5, 3, 2, 30), last: usage(1, 1, 1, 1, 7), expected: usage(9, 4, 2, 1, 23),
  }) },
  { name: "zero last snapshot is not a model call", arrange: () => ({
    total: usage(), last: usage(0, 0, 0, 0), expected: undefined,
  }) },
  { name: "total cannot undercount components", arrange: () => ({
    total: usage(10, 5, 3, 2, 19), last: usage(1, 1, 1, 1), expected: undefined,
  }) },
  { name: "last cannot undercount components", arrange: () => ({
    total: usage(), last: usage(1, 1, 1, 1, 3), expected: undefined,
  }) },
  { name: "remainder cannot undercount components", arrange: () => ({
    total: usage(), last: usage(1, 1, 1, 1, 7), expected: undefined,
  }) },
  { name: "overflowing component sum is invalid", arrange: () => ({
    total: usage(Number.MAX_VALUE, Number.MAX_VALUE, 0, 0, Number.MAX_VALUE),
    last: usage(1, 1, 0, 0), expected: undefined,
  }) },
  { name: "unknown fields are not copied", arrange: () => ({
    total: Object.assign(usage(), { speculative: 10 }),
    last: Object.assign(usage(1, 1, 1, 1), { speculative: 1 }), expected: usage(9, 4, 2, 1),
  }) },
];

for (const scope of ["tokens", "cost", "optional"] as const) {
  const fields = scope === "tokens" ? ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]
    : scope === "cost" ? ["input", "output", "cacheRead", "cacheWrite", "total"]
    : ["reasoning", "cacheWrite1h"];
  for (const field of fields) {
    for (const side of ["total", "last"] as const) {
      for (const invalid of [-1, NaN, Infinity, -Infinity, "1", null, undefined]) {
        if (scope === "optional" && invalid === undefined) continue;
        cases.push({ name: `${side} ${scope}.${field} rejects ${String(invalid)}`, arrange: () => {
          const total = usage();
          const last = usage(1, 1, 1, 1);
          const target = side === "total" ? total : last;
          Object.assign(scope === "cost" ? target.cost : target, { [field]: invalid });
          return { total, last, expected: undefined };
        } });
      }
    }
    cases.push({ name: `${scope}.${field} rejects last greater than total`, arrange: () => {
      const total = usage();
      const last = usage(1, 1, 1, 1);
      Object.assign(scope === "cost" ? last.cost : last, { [field]: 100 });
      return { total, last, expected: undefined };
    } });
  }
}

for (const side of ["total", "last"] as const) {
  for (const invalid of [null, undefined]) {
    cases.push({ name: `${side} missing usage rejects ${String(invalid)}`, arrange: () => ({
      total: usage(), last: usage(1, 1, 1, 1), [side]: invalid as unknown as Usage, expected: undefined,
    }) });
    cases.push({ name: `${side} missing cost rejects ${String(invalid)}`, arrange: () => {
      const total = usage();
      const last = usage(1, 1, 1, 1);
      Object.assign(side === "total" ? total : last, { cost: invalid });
      return { total, last, expected: undefined };
    } });
  }
}

for (const row of cases) {
  test(`splitPromptUsage: ${row.name}`, () => {
    const { total, last, expected } = row.arrange();
    const before = structuredClone({ total, last });
    if (total) { if (total.cost) Object.freeze(total.cost); Object.freeze(total); }
    if (last) { if (last.cost) Object.freeze(last.cost); Object.freeze(last); }

    const actual = splitPromptUsage(total, last);

    assert.deepEqual(actual, expected);
    assert.deepEqual({ total, last }, before, "inputs stay unchanged");
    if (actual) {
      assert.notStrictEqual(actual, total);
      assert.notStrictEqual(actual, last);
      assert.notStrictEqual(actual.cost, total.cost);
      assert.notStrictEqual(actual.cost, last.cost);
    }
  });
}
