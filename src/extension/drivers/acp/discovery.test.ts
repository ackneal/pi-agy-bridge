import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { discoverAcpModels } from "./discovery.ts";

for (const mode of ["catalog", "missing", "empty", "required", "failure", "hang", "cancel"]) {
  test(`ACP discovery ${mode}`, async () => {
    const options = { executable: process.execPath, cwd: process.cwd(), args: ["--experimental-strip-types", fileURLToPath(new URL("./discovery-fixture.ts", import.meta.url)), mode === "cancel" ? "hang" : mode], requestTimeoutMs: 1500 };
    const start = Date.now();
    if (mode === "catalog") {
      const models = await discoverAcpModels(options);
      assert.equal(models[0]?.id, "novel");
      assert.equal(models[0]?.thinkingLevelMap?.high, "high");
      assert.equal(models[0]?.thinkingLevelMap?.low, null);
    } else {
      await assert.rejects(discoverAcpModels(options, mode === "cancel" ? AbortSignal.timeout(600) : undefined),
        mode === "missing" ? /configuration/ : mode === "empty" ? /empty/ : mode === "required" ? /Authentication required/ : mode === "failure" ? /synthetic failure/ : /timeout|disposed|aborted/i);
    }
    assert.ok(Date.now() - start < 4000, "bounded cleanup");
  });
}
