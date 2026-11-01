import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

export function useExecutable(t: TestContext, executable: string | undefined): void {
  const previous = process.env.AGY_ACP_DIR;
  const directory = executable === undefined ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), "acp-executable-"));
  t.after(() => {
    if (previous === undefined) delete process.env.AGY_ACP_DIR;
    else process.env.AGY_ACP_DIR = previous;
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  if (directory && executable !== undefined) {
    fs.symlinkSync(path.resolve(executable), path.join(directory, "agy_acp_server.par"));
    fs.writeFileSync(path.join(directory, "localharness_external"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    process.env.AGY_ACP_DIR = directory;
  } else {
    delete process.env.AGY_ACP_DIR;
  }
}
