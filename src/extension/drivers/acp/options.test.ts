import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectAcpExecutable, resolveAcpConnectionOptions } from "./options.ts";

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
  { name: "environment non-executable does not fall back to implicit search", files: [["env", "plain"], [local, "executable"]], env: "env" },
  { name: "environment directory rejected", files: [["env", "directory"]], env: "env" },
  { name: "environment executable symlink accepted", files: [["target", "executable"], ["env", "symlink"]], env: "env", expected: "env" },
  { name: "implicit versioned distribution ignored", files: [[par, "executable"], [bin, "executable"], [local, "executable"]] },
  { name: "implicit versioned executable ignored", files: [[par, "plain"], [bin, "executable"]] },
  { name: "implicit versioned directory ignored", files: [[par, "directory"], [bin, "executable"]] },
  { name: "implicit executable symlink ignored", files: [["target", "executable"], [direct, "symlink"]] },
  { name: "direct non-executable skipped", files: [[direct, "plain"], [local, "executable"]] },
  { name: "local non-executable ignored", files: [[local, "plain"]] },
  { name: "local directory ignored", files: [[local, "directory"]] },
  { name: "unreadable implicit search ignored", files: [[".local/opt/agy-acp", "plain"], [local, "executable"]] },
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

for (const source of ["explicit", "environment"] as const) {
  test(`relative ACP ${source} path is anchored before changing workspace`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-relative-path-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const executable = path.join(directory, "agy_acp_server");
    fs.writeFileSync(executable, "not a program\n", { mode: 0o700 });
    const relative = path.relative(process.cwd(), executable);
    const previous = process.env.AGY_ACP_BIN;
    t.after(() => {
      if (previous === undefined) delete process.env.AGY_ACP_BIN;
      else process.env.AGY_ACP_BIN = previous;
    });
    if (source === "environment") process.env.AGY_ACP_BIN = relative;

    assert.equal(detectAcpExecutable(source === "explicit" ? relative : undefined), executable);
  });
}

const connectionRows = [
  { name: "missing executable", executable: undefined },
  { name: "empty executable", executable: "" },
  { name: "blank executable", executable: "  " },
  { name: "default home", executable: "/driver/owned/acp" },
  { name: "empty override uses home", executable: "/driver/owned/acp", override: "" },
  { name: "absolute override", executable: "/driver/owned/acp", override: "absolute" },
  { name: "tilde override", executable: "/driver/owned/acp", override: "~/custom" },
];

for (const row of connectionRows) {
  test(`connection options: ${row.name}`, (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "acp-cwd-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    t.mock.method(os, "homedir", () => home);
    const previous = process.env.GEMINI_HOME;
    t.after(() => {
      if (previous === undefined) delete process.env.GEMINI_HOME;
      else process.env.GEMINI_HOME = previous;
    });
    const override = row.override === "absolute" ? path.join(home, "override", "nested") : row.override;
    if (override === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = override;

    if (!row.executable?.trim()) {
      // An unusable home must not obscure executable validation or create directories.
      process.env.GEMINI_HOME = path.join(home, "invalid");
      fs.writeFileSync(process.env.GEMINI_HOME, "not a directory");
      assert.throws(() => resolveAcpConnectionOptions(row.executable), /executable not found/);
      assert.deepEqual(fs.readdirSync(home), ["invalid"]);
      return;
    }

    const result = resolveAcpConnectionOptions(row.executable);

    const root = override === "~/custom" ? path.join(home, "custom") : override || path.join(home, ".gemini");
    assert.deepEqual(result, { executable: row.executable, cwd: path.join(root, "antigravity-acp"), ...(process.platform === "linux" ? { args: ["--uid="] } : {}) });
    assert.notEqual(result.cwd, process.cwd());
    assert.ok(fs.statSync(result.cwd).isDirectory());
    assert.deepEqual(resolveAcpConnectionOptions(row.executable), result);
  });
}
