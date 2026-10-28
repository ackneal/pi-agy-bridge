import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "node:test";

/** Isolate Pi credential storage for each test that may synchronize authentication. */
export function useAuthHomeFixture(): void {
  const homes: Array<{ previous: string | undefined; directory: string }> = [];
  beforeEach(async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    const directory = await mkdtemp(path.join(os.tmpdir(), "agy-auth-home-"));
    homes.push({ previous, directory });
    process.env.PI_CODING_AGENT_DIR = directory;
  });
  afterEach(async () => {
    const home = homes.pop();
    if (!home) return;
    if (home.previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = home.previous;
    await rm(home.directory, { recursive: true, force: true });
  });
}

/** Register cleanup on a test context for startup tests. */
export function registerAuthHomeFixture(t: { after(callback: () => void | Promise<void>): void }): Promise<string> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  return mkdtemp(path.join(os.tmpdir(), "agy-auth-home-")).then((directory) => {
    process.env.PI_CODING_AGENT_DIR = directory;
    t.after(async () => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    });
    return directory;
  });
}
