import assert from "node:assert/strict";
import { test } from "node:test";
import { liveModel, liveSettings } from "./settings.ts";

for (const row of [
  { name: "defaults", env: {}, expected: { model: "gemini-3.8-flash", effort: "low" } },
  { name: "explicit settings", env: { PI_AGY_LIVE_MODEL: "other-model", PI_AGY_LIVE_EFFORT: "high" }, expected: { model: "other-model", effort: "high" } },
  { name: "medium", env: { PI_AGY_LIVE_EFFORT: "medium" }, expected: { model: "gemini-3.8-flash", effort: "medium" } },
  { name: "blank model", env: { PI_AGY_LIVE_MODEL: " " }, error: /MODEL/ },
  { name: "blank effort", env: { PI_AGY_LIVE_EFFORT: "" }, error: /EFFORT/ },
  { name: "unsupported effort", env: { PI_AGY_LIVE_EFFORT: "off" }, error: /EFFORT/ },
]) {
  test(`live settings: ${row.name}`, () => {
    if (row.error) assert.throws(() => liveSettings(row.env), row.error);
    else {
      assert.deepEqual(liveSettings(row.env), row.expected);
      const model = liveModel(row.env);
      assert.equal(model.id, row.expected!.model);
      assert.equal(model.reasoning, true, "Pi must not clamp the requested low effort to off");
    }
  });
}
