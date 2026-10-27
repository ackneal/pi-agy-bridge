import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import type { DriverId } from "./types.ts";
import { AcpDriver } from "./acp/driver.ts";
import { CliDriver } from "./cli/driver.ts";
import { createBridgeDriver } from "./driver.ts";

for (const scenario of [
  { name: "default", id: undefined, expected: "acp" },
  { name: "ACP", id: "acp", expected: "acp" },
  { name: "CLI", id: "cli", expected: "cli" },
] satisfies { name: string; id: DriverId | undefined; expected: "cli" | "acp" }[]) {
  test(`driver selection does not detect or fall back: ${scenario.name}`, (t) => {
    const unexpected = () => { throw new Error("Selection must not inspect executables or authentication"); };
    const inspections = [
      t.mock.method(fs, "existsSync", unexpected),
      t.mock.method(fs, "statSync", unexpected),
      t.mock.method(fs, "accessSync", unexpected),
      t.mock.method(cp, "spawn", unexpected),
      t.mock.method(cp, "execFile", unexpected),
    ];
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

    const driver = createBridgeDriver(scenario.id);

    assert.equal(driver.id, scenario.expected);
    assert.equal(driver.sessionVersion, `${scenario.expected}:v1`);
    assert.ok(driver instanceof (scenario.expected === "acp" ? AcpDriver : CliDriver));
    for (const inspection of inspections) assert.equal(inspection.mock.callCount(), 0);
    if (scenario.expected === "acp") {
      assert.ok(driver.initialModels.some((model) => model.id === "gemini-3.8-flash"));
    } else {
      assert.deepEqual(driver.initialModels, []);
    }
  });
}

test("unsupported driver is rejected instead of selecting a backend", () => {
  const id = "invalid" as DriverId;

  assert.throws(() => createBridgeDriver(id), /Unsupported Antigravity driver: invalid/);
});
