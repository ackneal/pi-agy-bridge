import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readVersion } from "./version.ts";

type Case = {
  name: string;
  script?: string;
  args?: string[];
  expected?: string;
  errorCode?: number | string;
};

const cases: Case[] = [
  { name: "reads the multiline Build label, not Python", script: "printf 'Python 3.13.2\\nBuild label: 1.4.1\\nOther: 2.0\\n'", expected: "1.4.1" },
  { name: "preserves required Linux arguments", script: "printf 'Build label: 1.4.3\\n'", args: ["--uid="], expected: "1.4.3" },
  { name: "trims the label", script: "printf 'Build label:   1.4.1  \\n'", expected: "1.4.1" },
  { name: "does not guess from unrelated versions", script: "printf 'Python 3.13.2\\nVersion: 1.4.1\\n'" },
  { name: "rejects an empty label", script: "printf 'Build label:\\n'" },
  { name: "rejects a whitespace label", script: "printf 'Build label:   \\n'" },
  { name: "does not consume the line after an empty label", script: "printf 'Build label: \\nPython 3.13.2\\n'" },
  { name: "reads stderr when stdout is empty", script: "printf 'Build label: 1.4.1\\n' >&2", expected: "1.4.1" },
  { name: "prefers nonempty stdout over stderr", script: "printf 'Python 3.13.2\\n'; printf 'Build label: 1.4.1\\n' >&2" },
  { name: "requires the precise field name", script: "printf 'build label: 1.4.1\\nOther Build label: 2.0\\n'" },
  { name: "propagates a nonzero exit even with a label", script: "printf 'Build label: 1.4.1\\n'; exit 7", errorCode: 7 },
  { name: "propagates spawn failure", errorCode: "ENOENT" },
];

for (const row of cases) {
  test(`readVersion: ${row.name}`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "acp-version-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = path.join(directory, "acp server");
    if (row.script !== undefined) {
      const expectedArgs = [...(row.args ?? []), "--version"].join(" ");
      await writeFile(executable, `#!/bin/sh\n[ "$*" = '${expectedArgs}' ] || exit 64\n${row.script}\n`, { mode: 0o700 });
    }

    if (row.errorCode !== undefined) {
      await assert.rejects(readVersion(executable, row.args ?? []), { code: row.errorCode });
    } else {
      assert.equal(await readVersion(executable, row.args ?? []), row.expected);
    }
  });
}
