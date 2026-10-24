import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import type { AgyBridgeConfig } from "../shared/types.ts";
import { resolveDriverId } from "./driver.ts";

const acpPath = path.resolve("synthetic-acp");
const agyPath = path.resolve("synthetic-cli");
const defaultAcp = path.join(os.homedir(), ".local", "bin", "agy_acp_server");
const defaultCli = path.join(os.homedir(), ".local", "bin", "agy");
const executableStat = fs.statSync(process.execPath);

for (const kind of ["missing", "directory", "non-executable", "executable"] as const) {
  test(`auto detection falls back to CLI only when ACP is unavailable: ${kind}`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-driver-availability-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const candidate = path.join(directory, "acp");
    if (kind === "directory") fs.mkdirSync(candidate);
    else if (kind !== "missing") fs.writeFileSync(candidate, "#!/bin/sh\nexit 0\n", { mode: kind === "executable" ? 0o755 : 0o644 });

    const selected = resolveDriverId({ acpPath: candidate, agyPath: process.execPath });

    assert.equal(selected, kind === "executable" ? "acp" : "cli");
  });
}

for (const config of [undefined, { agyPath }, { acpPath }, { agyPath, acpPath }] satisfies (AgyBridgeConfig | undefined)[]) {
  for (const available of [[], ["acp"], ["cli"], ["acp", "cli"]]) {
    test(`auto detection: ${JSON.stringify(config)} with ${available.join(" + ") || "neither"} available`, (t) => {
      const existing = new Set<string>();
      if (available.includes("acp")) existing.add(config?.acpPath ?? defaultAcp);
      if (available.includes("cli")) existing.add(config?.agyPath ?? defaultCli);
      t.mock.method(fs, "existsSync", (candidate: fs.PathLike) => existing.has(String(candidate)));
      t.mock.method(fs, "statSync", (candidate: fs.PathLike) => {
        if (!existing.has(String(candidate))) throw new Error("Missing executable");
        return executableStat;
      });
      t.mock.method(fs, "accessSync", (candidate: fs.PathLike) => {
        if (!existing.has(String(candidate))) throw new Error("Executable is not accessible");
      });
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });

      if (available.length === 0) {
        assert.throws(() => resolveDriverId(config), { message: "Neither Antigravity ACP nor Antigravity CLI executable found" });
      } else {
        assert.equal(resolveDriverId(config), available.includes("acp") ? "acp" : "cli");
      }
    });
  }
}

for (const scenario of [
  { driver: "cli", expected: "cli" },
  { driver: "acp", expected: "acp" },
  { driver: "invalid", expected: undefined },
] as const) {
  test(`explicit driver: ${scenario.driver}`, (t) => {
    const detection = t.mock.method(fs, "existsSync", () => { throw new Error("Explicit selection must not detect executables"); });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    // Invalid driver values can arrive from untyped configuration.
    const config = { driver: scenario.driver, agyPath, acpPath } as AgyBridgeConfig;

    if (scenario.expected === undefined) {
      assert.throws(() => resolveDriverId(config), { message: "Unsupported Antigravity driver: invalid" });
    } else {
      assert.equal(resolveDriverId(config), scenario.expected);
    }
    assert.equal(detection.mock.callCount(), 0);
  });
}
