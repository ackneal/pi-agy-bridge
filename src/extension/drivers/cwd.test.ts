import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareDriverCwd } from "./cwd.ts";

const cases = (["cli", "acp"] as const).flatMap((driver) =>
  (["default", "environment", "expanded home", "empty environment"] as const).map((source) => ({ driver, source })));

for (const { driver, source } of cases) {
  test(`${driver} working directory: ${source}`, (t) => {
    const home = mkdtempSync(path.join(os.tmpdir(), "agy-driver-cwd-"));
    const previous = process.env.GEMINI_HOME;
    t.after(() => {
      if (previous === undefined) delete process.env.GEMINI_HOME;
      else process.env.GEMINI_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    });
    t.mock.method(os, "homedir", () => home);
    const configured = source === "environment" ? path.join(home, "custom") : source === "expanded home" ? "~/custom" : "";
    if (source === "default") delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = configured;
    const base = source === "environment" || source === "expanded home" ? path.join(home, "custom") : path.join(home, ".gemini");

    const cwd = prepareDriverCwd(driver);

    assert.equal(cwd, path.join(base, `antigravity-${driver}`));
    assert.equal(statSync(cwd).isDirectory(), true);
    assert.equal(prepareDriverCwd(driver), cwd);
  });
}
