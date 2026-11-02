import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeProbeIdentity, type ProbeIdentity } from "./acp-probe-identity.ts";

const complete: ProbeIdentity = { server: "pi-agy-bridge_pi", tool: "mcp__pi__offload_probe", conflict: false };
for (const row of [
  { name: "no metadata is unchanged", prior: complete, meta: undefined, expected: complete },
  { name: "null metadata is unchanged", prior: complete, meta: null, expected: complete },
  { name: "unrelated metadata is unchanged", prior: complete, meta: { progress: 1 }, expected: complete },
  { name: "partial server preserves tool", prior: complete, meta: { mcp: { server: complete.server } }, expected: complete },
  { name: "partial tool preserves server", prior: complete, meta: { mcp: { tool: complete.tool } }, expected: complete },
  { name: "partial first identity", prior: undefined, meta: { mcp: { server: complete.server } }, expected: { server: complete.server, tool: "", conflict: false } },
  { name: "partial identity completed", prior: { server: complete.server, tool: "", conflict: false }, meta: { mcp: { tool: complete.tool } }, expected: complete },
  { name: "conflicting server rejected", prior: complete, meta: { mcp: { server: "other" } }, expected: { ...complete, conflict: true } },
  { name: "conflicting tool rejected", prior: complete, meta: { mcp: { tool: "other" } }, expected: { ...complete, conflict: true } },
  { name: "malformed metadata rejected", prior: complete, meta: [], expected: { ...complete, conflict: true } },
  { name: "null identity rejected", prior: complete, meta: { mcp: null }, expected: { ...complete, conflict: true } },
  { name: "malformed identity field rejected", prior: complete, meta: { mcp: { tool: 4 } }, expected: { ...complete, conflict: true } },
  { name: "empty identity field rejected", prior: complete, meta: { mcp: { server: "" } }, expected: { ...complete, conflict: true } },
  { name: "conflict cannot rearm", prior: { ...complete, conflict: true }, meta: { mcp: complete }, expected: { ...complete, conflict: true } },
]) {
  test(`probe identity: ${row.name}`, () => {
    const before = structuredClone(row.prior);
    const result = mergeProbeIdentity(row.prior, row.meta);
    assert.deepEqual(result, row.expected);
    assert.deepEqual(row.prior, before, "Delta merging must not mutate prior evidence");
  });
}
