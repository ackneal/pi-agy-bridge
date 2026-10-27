import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome } from "../shared/paths.ts";
import type { DriverId } from "./types.ts";

export function prepareDriverCwd(driver: DriverId): string {
  const home = expandHome(process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini"));
  const cwd = path.resolve(home, `antigravity-${driver}`);
  mkdirSync(cwd, { recursive: true });
  return cwd;
}
