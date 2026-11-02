import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { serializeConversation } from "../../src/extension/provider/context-prompt.ts";
import { assertReconstructionAnswer, assertReconstructionRecords, reconstructionHistory } from "./reconstruction.ts";

const model: Model<any> = {
  id: "fixture", name: "fixture", api: "agy", provider: "agy", baseUrl: "", reasoning: false,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000,
};
const hidden = "private-result-body";
const valid = { classifications: { confirmed: "SUCCESS", failed: "ERROR", cancelled: "ABORTED", unresolved: "UNKNOWN" }, bodyKnown: false, retry: false };

for (const row of [
  { name: "accept exact outcomes", text: JSON.stringify(valid), error: undefined },
  { name: "reject non JSON", text: "not JSON", error: /answer.json/ },
  { name: "reject null", text: "null", error: /answer.object/ },
  { name: "reject guessed outcome", text: JSON.stringify({ ...valid, classifications: { ...valid.classifications, unresolved: "SUCCESS" } }), error: /answer.classifications/ },
  { name: "reject claimed hidden knowledge", text: JSON.stringify({ ...valid, bodyKnown: true }), error: /answer.bodyKnown/ },
  { name: "reject retries", text: JSON.stringify({ ...valid, retry: true }), error: /answer.retry/ },
]) {
  test(`reconstruction answer oracle: ${row.name}`, () => {
    if (row.error) assert.throws(() => assertReconstructionAnswer(row.text), row.error);
    else assertReconstructionAnswer(row.text);
  });
}

const serialized = serializeConversation(reconstructionHistory(model, hidden));
for (const row of [
  { name: "production fixture statuses and omitted body", text: serialized, error: undefined },
  { name: "success record required", text: serialized.replace('operation="confirmed"', 'operation="other"'), error: /records.confirmed/ },
  { name: "error record required", text: serialized.replace("ERROR: fixture failure", "UNKNOWN"), error: /records.failed/ },
  { name: "Operation aborted is aborted not error", text: serialized.replace(" — ABORTED", " — ERROR"), error: /records.cancelled/ },
  { name: "unresolved is unknown not aborted", text: serialized.replace(" — UNKNOWN", " — ABORTED"), error: /records.unresolved/ },
  { name: "hidden body forbidden", text: `${serialized}\n${hidden}`, error: /records.hiddenBody/ },
]) {
  test(`reconstruction record oracle: ${row.name}`, () => {
    if (row.error) assert.throws(() => assertReconstructionRecords(row.text, hidden), row.error);
    else assertReconstructionRecords(row.text, hidden);
  });
}
