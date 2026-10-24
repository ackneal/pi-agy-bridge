import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectAcpExecutable } from "./options.ts";

const local = ".local/bin/agy_acp_server";
const par = ".local/opt/agy-acp/v1/agy_acp_server.par";
const bin = ".local/opt/agy-acp/v1/agy_acp_server";
const direct = ".local/opt/agy-acp/agy_acp_server";
type Fixture = readonly [string, "executable" | "plain" | "directory" | "symlink" | "broken" | "loop"];
const rows: { name: string; files: Fixture[]; custom?: string; env?: string; expected?: string }[] = [
  { name: "explicit wins over environment and search", files: [["custom", "executable"], ["env", "executable"], [local, "executable"]], custom: "custom", env: "env", expected: "custom" },
  { name: "explicit non-executable does not fall back", files: [["custom", "plain"], ["env", "executable"]], custom: "custom", env: "env" },
  { name: "explicit directory rejected", files: [["custom", "directory"]], custom: "custom" },
  { name: "explicit missing rejected", files: [], custom: "missing" },
  { name: "explicit symlink accepted", files: [["target", "executable"], ["custom", "symlink"]], custom: "custom", expected: "custom" },
  { name: "broken symlink rejected", files: [["custom", "broken"]], custom: "custom" },
  { name: "filesystem error rejected", files: [["custom", "loop"]], custom: "custom" },
  { name: "environment wins over search", files: [["env", "executable"], [local, "executable"]], env: "env", expected: "env" },
  { name: "environment non-executable falls back", files: [["env", "plain"], [local, "executable"]], env: "env", expected: local },
  { name: "environment directory rejected", files: [["env", "directory"]], env: "env" },
  { name: "environment executable symlink accepted", files: [["target", "executable"], ["env", "symlink"]], env: "env", expected: "env" },
  { name: "versioned par preferred", files: [[par, "executable"], [bin, "executable"], [local, "executable"]], expected: par },
  { name: "non-executable par skipped", files: [[par, "plain"], [bin, "executable"]], expected: bin },
  { name: "directory par skipped", files: [[par, "directory"], [bin, "executable"]], expected: bin },
  { name: "direct executable symlink accepted", files: [["target", "executable"], [direct, "symlink"]], expected: direct },
  { name: "direct non-executable skipped", files: [[direct, "plain"], [local, "executable"]], expected: local },
  { name: "local non-executable rejected", files: [[local, "plain"]] },
  { name: "local directory rejected", files: [[local, "directory"]] },
  { name: "unreadable search shape falls back", files: [[".local/opt/agy-acp", "plain"], [local, "executable"]], expected: local },
  { name: "no candidates", files: [] },
];

for (const row of rows) {
  test(`detectAcpExecutable: ${row.name}`, (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "acp-options-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    t.mock.method(os, "homedir", () => home);
    const previous = process.env.AGY_ACP_BIN;
    t.after(() => {
      if (previous === undefined) delete process.env.AGY_ACP_BIN;
      else process.env.AGY_ACP_BIN = previous;
    });
    delete process.env.AGY_ACP_BIN;

    for (const [name, kind] of row.files) {
      const filepath = path.join(home, name);
      fs.mkdirSync(path.dirname(filepath), { recursive: true });
      if (kind === "directory") fs.mkdirSync(filepath);
      else if (kind === "symlink" || kind === "broken" || kind === "loop") {
        fs.symlinkSync(kind === "loop" ? filepath : path.join(home, kind === "symlink" ? "target" : "missing"), filepath);
      } else {
        // Deliberately not a runnable program: detection must not launch auth probes.
        fs.writeFileSync(filepath, "not a program\n");
        fs.chmodSync(filepath, kind === "executable" ? 0o700 : 0o600);
      }
    }
    if (row.env) process.env.AGY_ACP_BIN = `~/${row.env}`;

    const result = detectAcpExecutable(row.custom ? `~/${row.custom}` : undefined);

    assert.equal(result, row.expected ? path.join(home, row.expected) : undefined);
  });
}
