import type { TestContext } from "node:test";

export function useExecutable(t: TestContext, executable: string | undefined): void {
  const previous = process.env.AGY_ACP_BIN;
  if (executable === undefined) delete process.env.AGY_ACP_BIN;
  else process.env.AGY_ACP_BIN = executable;
  t.after(() => {
    if (previous === undefined) delete process.env.AGY_ACP_BIN;
    else process.env.AGY_ACP_BIN = previous;
  });
}
