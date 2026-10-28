import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { AcpDriver } from "./driver.ts";

for (const mode of ["catalog", "browser"] as const) {
  test(`ACP background auth and discovery clean up after ${mode}`, async (t) => {
    const previous = process.env.AGY_ACP_BIN;
    delete process.env.AGY_ACP_BIN;
    t.after(() => { if (previous === undefined) delete process.env.AGY_ACP_BIN; else process.env.AGY_ACP_BIN = previous; });
    let installs = 0;
    const driver = new AcpDriver(async () => {
      installs++;
      return { executable: process.execPath, args: ["--experimental-strip-types", fileURLToPath(new URL("./discovery-fixture.ts", import.meta.url)), mode] };
    });
    const listeners = process.listenerCount("exit");

    assert.equal(await driver.authentication.probe(new AbortController().signal, () => {}), mode === "catalog");
    const models = await driver.discoverModels(new AbortController().signal);

    if (mode === "catalog") assert.equal(models?.[0]?.id, "novel");
    else assert.equal(models, undefined);
    assert.equal(installs, 2);
    assert.equal(process.listenerCount("exit"), listeners);
  });
}
