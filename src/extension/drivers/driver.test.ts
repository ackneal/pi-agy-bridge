import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { describe, test } from "node:test";
import type { DriverId } from "./types.ts";
import { Driver as AcpDriver } from "./acp/driver.ts";
import { prepareRuntime as prepareAcpRuntime } from "./acp/prepare.ts";
import { Driver as CliDriver } from "./cli/driver.ts";
import { prepareRuntime as prepareCliRuntime, resolveModelAndEffort } from "./cli/session.ts";
import { Driver as CliAcpDriver } from "./cli-acp/driver.ts";
import { createBridgeDriver } from "./driver.ts";
import { parseModelsOutput } from "../discovery/models.ts";
import { LiveSession } from "../session/session.ts";

describe("createBridgeDriver", () => {
  for (const scenario of [
    { name: "default", id: undefined, expected: "acp" },
    { name: "ACP", id: "acp", expected: "acp" },
    { name: "CLI", id: "cli", expected: "cli" },
    { name: "CLI-ACP", id: "cli-acp", expected: "cli-acp" },
  ] satisfies { name: string; id: DriverId | undefined; expected: DriverId }[]) {
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
      assert.ok(driver instanceof (scenario.expected === "acp" ? AcpDriver : scenario.expected === "cli" ? CliDriver : CliAcpDriver));
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
});

describe("session version propagation", () => {
  for (const driver of ["cli", "acp"] as const) {
    test(`${driver} preparation passes the supplied session version unchanged`, async (t) => {
      const session = new LiveSession("pi-version-routing");
      t.after(() => session.dispose());
      const preparationId = session.beginPreparation();
      const model = parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)")[0]!;
      const version = "opaque-custom-format:v7";
      const stopAfterRead = new Error("stop after verifying state lookup");
      const reads: unknown[][] = [];
      const dependencies = {
        sessionVersion: version,
        store: {
          get: async (...args: [string, string]) => {
            reads.push(args);
            throw stopAfterRead;
          },
          delete: async () => { throw new Error("Preparation must stop at lookup"); },
        },
        sync: {
          decide: () => { throw new Error("Preparation must stop at lookup"); },
        },
        installPlugin: async () => { throw new Error("Preparation must stop at lookup"); },
      };
      const options = { env: { AGY_BRIDGE_ENABLED: "1" } };

      const preparing = driver === "cli"
        ? prepareCliRuntime(model, { messages: [] }, [], options, process.cwd(), dependencies, session, resolveModelAndEffort(model.id), preparationId)
        : prepareAcpRuntime(model, { messages: [] }, [], [], options, { cwd: process.cwd(), resolve: async () => { throw new Error("Preparation must stop at lookup"); } }, dependencies, session, preparationId);
      await assert.rejects(preparing, stopAfterRead);

      assert.deepEqual(reads, [[session.piSessionId, version]]);
    });
  }
});
