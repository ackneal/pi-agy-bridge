import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Driver } from "./driver.ts";
import { detectExecutable, resolveConnectionOptions } from "./options.ts";

type FileKind = "executable" | "plain" | "directory" | "missing" | "symlink" | "broken" | "loop";
const rows: { name: string; directory?: string; server?: FileKind; helper?: FileKind; valid?: boolean }[] = [
  { name: "valid absolute distribution", valid: true },
  { name: "absolute directory with spaces", directory: "with spaces", valid: true },
  { name: "missing directory", directory: "missing" },
  { name: "file instead of directory", directory: "file" },
  { name: "relative directory", directory: "relative" },
  { name: "literal tilde", directory: "~" },
  { name: "tilde directory", directory: "~/distribution" },
  { name: "missing server", server: "missing" },
  { name: "nonexecutable server", server: "plain" },
  { name: "directory server", server: "directory" },
  { name: "missing helper", helper: "missing" },
  { name: "nonexecutable helper", helper: "plain" },
  { name: "directory helper", helper: "directory" },
  { name: "server symlink", server: "symlink", valid: true },
  { name: "helper symlink", helper: "symlink", valid: true },
  { name: "broken server symlink", server: "broken" },
  { name: "broken helper symlink", helper: "broken" },
  { name: "filesystem error", server: "loop" },
  { name: "empty", directory: "" },
  { name: "blank", directory: "  " },
  { name: "unset", directory: "unset" },
];

for (const row of rows) {
  test(`detectExecutable: ${row.name}`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-options-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    t.mock.method(os, "homedir", () => root);
    const previous = process.env.AGY_ACP_DIR;
    t.after(() => {
      if (previous === undefined) delete process.env.AGY_ACP_DIR;
      else process.env.AGY_ACP_DIR = previous;
    });

    const directory = path.join(root, row.directory === "with spaces" ? "with spaces" : "distribution");
    fs.mkdirSync(directory);
    for (const [name, kind] of [["agy_acp_server.par", row.server ?? "executable"], ["localharness_external", row.helper ?? "executable"]] as const) {
      const filepath = path.join(directory, name);
      if (kind === "missing") continue;
      if (kind === "directory") fs.mkdirSync(filepath);
      else if (kind === "symlink" || kind === "broken" || kind === "loop") {
        const target = path.join(root, `${name}-target`);
        if (kind === "symlink") fs.writeFileSync(target, "not a program\n", { mode: 0o700 });
        fs.symlinkSync(kind === "loop" ? filepath : target, filepath);
      } else {
        // Detection must not launch the executable.
        fs.writeFileSync(filepath, "not a program\n", { mode: kind === "executable" ? 0o700 : 0o600 });
      }
    }

    let override: string | undefined = directory;
    if (row.directory === "missing") override = path.join(root, "missing");
    else if (row.directory === "file") {
      override = path.join(root, "file");
      fs.writeFileSync(override, "not a directory");
    } else if (row.directory === "relative") override = path.relative(process.cwd(), directory);
    else if (row.directory === "unset") override = undefined;
    else if (row.directory !== undefined && row.directory !== "with spaces") override = row.directory;
    if (override === undefined) delete process.env.AGY_ACP_DIR;
    else process.env.AGY_ACP_DIR = override;

    assert.equal(detectExecutable(), row.valid ? path.join(directory, "agy_acp_server.par") : undefined);

    if (!row.valid && override?.trim() && (process.platform === "linux" || process.platform === "darwin")) {
      let installs = 0;
      const driver = new Driver(async () => {
        installs++;
        throw new Error("unexpected managed installation");
      });
      assert.equal(driver.detectExecutable(), undefined);
      await assert.rejects(driver.authentication.probe(new AbortController().signal, () => {}), /AGY_ACP_DIR must be an absolute directory containing executable regular files agy_acp_server\.par and localharness_external/);
      assert.equal(installs, 0);
    }
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
      assert.throws(() => resolveConnectionOptions(row.executable), /executable not found/);
      assert.deepEqual(fs.readdirSync(home), ["invalid"]);
      return;
    }

    const result = resolveConnectionOptions(row.executable);

    const root = override === "~/custom" ? path.join(home, "custom") : override || path.join(home, ".gemini");
    assert.deepEqual(result, { executable: row.executable, cwd: path.join(root, "antigravity-acp"), ...(process.platform === "linux" ? { args: ["--uid="] } : {}) });
    assert.notEqual(result.cwd, process.cwd());
    assert.ok(fs.statSync(result.cwd).isDirectory());
    assert.deepEqual(resolveConnectionOptions(row.executable), result);
  });
}
