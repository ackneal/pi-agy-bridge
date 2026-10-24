import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import type { AgyBridgeConfig } from "../shared/types.ts";
import { AcpDriver } from "./acp/driver.ts";
import { CliDriver } from "./cli/driver.ts";
import { createBridgeDriver, resolveDriverId } from "./driver.ts";

for (const scenario of [
  { name: "no configuration", config: undefined, expected: "acp" },
  { name: "CLI path alone", config: { agyPath: process.execPath }, expected: "acp" },
  { name: "missing ACP with an installed CLI", config: { acpPath: "/nonexistent/acp", agyPath: process.execPath }, expected: "acp" },
  { name: "ACP path alone", config: { acpPath: process.execPath }, expected: "acp" },
  { name: "both paths", config: { acpPath: process.execPath, agyPath: process.execPath }, expected: "acp" },
  { name: "explicit ACP", config: { driver: "acp" }, expected: "acp" },
  { name: "explicit CLI without an executable", config: { driver: "cli", agyPath: "/nonexistent/cli" }, expected: "cli" },
  { name: "explicit CLI with ACP installed", config: { driver: "cli", acpPath: process.execPath }, expected: "cli" },
] satisfies { name: string; config: AgyBridgeConfig | undefined; expected: "cli" | "acp" }[]) {
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

    const id = resolveDriverId(scenario.config);
    const driver = createBridgeDriver(scenario.config);

    assert.equal(id, scenario.expected);
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
  const config = { driver: "invalid" } as unknown as AgyBridgeConfig;

  assert.throws(() => createBridgeDriver(config), /Unsupported Antigravity driver: invalid/);
});
