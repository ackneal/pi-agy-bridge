import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { detectCliExecutable, resolveAgyExecutable, validateAgyVersion } from "./version.ts";
import { expandHome } from "../shared/paths.ts";

for (const row of [
  { input: "~", expected: os.homedir() },
  { input: "~/bin/agy", expected: path.join(os.homedir(), "bin/agy") },
  { input: "~someone/bin/agy", expected: "~someone/bin/agy" },
  { input: "/opt/bin/agy", expected: "/opt/bin/agy" },
  { input: "relative/agy", expected: "relative/agy" },
]) {
  test(`home expansion preserves path semantics: ${row.input}`, () => {
    assert.equal(expandHome(row.input), row.expected);
    assert.equal(resolveAgyExecutable(row.input), row.expected);
  });
}

for (const source of ["explicit", "PATH"] as const) {
  test(`relative CLI ${source} path is anchored before changing workspace`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-relative-path-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    t.mock.method(os, "homedir", () => directory);
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const executable = path.join(directory, "agy");
    fs.writeFileSync(executable, "not a program\n", { mode: 0o700 });
    const previous = process.env.PATH;
    t.after(() => {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    });
    process.env.PATH = path.relative(process.cwd(), directory);

    assert.equal(detectCliExecutable(source === "explicit" ? path.relative(process.cwd(), executable) : undefined), executable);
  });
}

for (const version of ["0.1.0", "1.4.2", "2.0.0"]) {
  test(`reads CLI version without a minimum gate: ${version}`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-version-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const executable = path.join(directory, "agy");
    fs.writeFileSync(executable, `#!/bin/sh\necho 'agy ${version}'\n`, { mode: 0o755 });

    assert.deepEqual(await validateAgyVersion(executable), { version });
  });
}

for (const exists of [true, false]) {
  for (const input of [undefined, "", "agy"]) {
    test(`default executable ${JSON.stringify(input)}, local exists=${exists}`, (t) => {
      const local = path.join(os.homedir(), ".local", "bin", "agy");
      const lookup = t.mock.method(fs, "existsSync", (candidate: fs.PathLike) => {
        assert.equal(candidate, local);
        return exists;
      });
      syncBuiltinESMExports();
      t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
      assert.equal(resolveAgyExecutable(input), exists ? local : "agy");
      assert.equal(lookup.mock.callCount(), 1);
    });
  }
}
