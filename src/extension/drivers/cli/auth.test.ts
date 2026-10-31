import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Driver } from "./driver.ts";

for (const authenticated of [false, true]) {
  test(`CLI usage probe reports authenticated=${authenticated}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-cli-auth-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = path.join(directory, "agy");
    await writeFile(executable, authenticated
      ? '#!/bin/sh\nprintf "Claude  Five hour  50%%\\n"\n'
      : '#!/bin/sh\nprintf "Authentication required. Please visit the URL to log in:\\n" >&2\nwhile :; do sleep 1; done\n', { mode: 0o700 });
    const driver = new Driver();
    driver.detectExecutable = () => executable;
    const onUsage = t.mock.fn();

    assert.equal(await driver.authentication.probe(new AbortController().signal, onUsage), authenticated);

    assert.equal(onUsage.mock.callCount(), authenticated ? 1 : 0);
    if (authenticated) {
      await driver.authentication.login({ signal: new AbortController().signal, notify: () => {}, prompt: async () => { throw new Error("Cached CLI login must not prompt"); } }, () => {});
    }
  });
}
