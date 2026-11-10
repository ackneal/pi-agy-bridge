import { calculateCost, type Api, type Model, type Usage } from "@earendil-works/pi-ai";

export function estimateUsageCost(model: Model<Api>, usage: Usage): Usage {
  const estimated = { ...usage, cost: { ...usage.cost } };
  calculateCost(model, estimated);
  return estimated;
}

function canSubtract(total: number, last: number): boolean {
  return Number.isFinite(total) && Number.isFinite(last) && last >= 0 && total >= last;
}

function validTokenTotal(usage: Usage): boolean {
  const components = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return Number.isFinite(components) && usage.totalTokens >= components;
}

/**
 * Use only with a fresh per-call snapshot and an open writer. If splitting fails,
 * the caller must account for the whole prompt total separately.
 */
export function splitPromptUsage(total: Usage, lastCall: Usage): Usage | undefined {
  if (!total || !lastCall || !total.cost || !lastCall.cost) return undefined;

  for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    if (!canSubtract(total[field], lastCall[field])) return undefined;
  }
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    if (!canSubtract(total.cost[field], lastCall.cost[field])) return undefined;
  }
  if (lastCall.totalTokens <= 0 || !validTokenTotal(total) || !validTokenTotal(lastCall)) return undefined;

  const remainder: Usage = {
    input: total.input - lastCall.input,
    output: total.output - lastCall.output,
    cacheRead: total.cacheRead - lastCall.cacheRead,
    cacheWrite: total.cacheWrite - lastCall.cacheWrite,
    totalTokens: total.totalTokens - lastCall.totalTokens,
    cost: {
      input: total.cost.input - lastCall.cost.input,
      output: total.cost.output - lastCall.cost.output,
      cacheRead: total.cost.cacheRead - lastCall.cost.cacheRead,
      cacheWrite: total.cost.cacheWrite - lastCall.cost.cacheWrite,
      total: total.cost.total - lastCall.cost.total,
    },
  };
  for (const field of ["reasoning", "cacheWrite1h"] as const) {
    const totalValue = total[field] === undefined ? 0 : total[field];
    const lastValue = lastCall[field] === undefined ? 0 : lastCall[field];
    if (!canSubtract(totalValue, lastValue)) return undefined;
    if (total[field] !== undefined || lastCall[field] !== undefined) {
      remainder[field] = totalValue - lastValue;
    }
  }

  // Native totals can include extra tokens, but cannot undercount known components.
  return validTokenTotal(remainder) ? remainder : undefined;
}
