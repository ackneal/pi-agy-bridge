import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Driver } from "./driver.ts";

test("CLI driver restores usage and live model discovery", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agy-cli-discovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "agy");
  await writeFile(executable, '#!/bin/sh\nif [ "$1" = "models" ]; then printf "gemini-3.8-flash-high  Gemini 3.8 Flash (High)\\n"; else printf "Claude  Five hour  50%%\\n"; fi\n', { mode: 0o700 });
  const driver = new Driver();
  t.mock.method(driver, "detectExecutable", () => executable);

  const usage = await driver.usage(new AbortController().signal);
  const models = await driver.discoverModels(new AbortController().signal);

  assert.ok(usage && usage.groups.length > 0);
  assert.equal(models[0]?.id, "gemini-3.8-flash");
  assert.equal(models[0]?.thinkingLevelMap?.high, "high");
});
