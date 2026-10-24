import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CompatibilityError } from "../shared/types.ts";
import { expandHome } from "../shared/paths.ts";
import { debugLog } from "../shared/debug.ts";

const execFileAsync = promisify(execFile);

export function resolveAgyExecutable(customPath?: string): string {
  if (customPath && customPath !== "agy") {
    return expandHome(customPath);
  }

  const standardLocal = path.join(os.homedir(), ".local", "bin", "agy");
  if (fs.existsSync(standardLocal)) {
    return standardLocal;
  }

  return "agy";
}

export function detectCliExecutable(customPath?: string): string | undefined {
  if (customPath && customPath !== "agy") {
    const resolved = expandHome(customPath);
    if (fs.existsSync(resolved)) return resolved;
    return undefined;
  }

  const standardLocal = path.join(os.homedir(), ".local", "bin", "agy");
  if (fs.existsSync(standardLocal)) return standardLocal;

  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "agy");
    if (fs.existsSync(candidate)) return candidate;
  }

  return undefined;
}

function parseSemver(versionStr: string): [number, number, number] {
  const match = versionStr.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match || !match[1] || !match[2] || !match[3]) {
    throw new CompatibilityError(`Failed to parse version string: "${versionStr}"`, {
      code: "INVALID_VERSION_STRING",
      details: { versionStr },
    });
  }

  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  const patch = parseInt(match[3], 10);

  return [major, minor, patch];
}

export async function validateAgyVersion(
  agyPath: string = "agy"
): Promise<{ version: string }> {
  const resolvedPath = resolveAgyExecutable(agyPath);

  let output: string;
  try {
    const { stdout, stderr } = await execFileAsync(resolvedPath, ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    output = (stdout || stderr).trim();
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      throw new CompatibilityError(
        `Antigravity CLI executable "${agyPath}" was not found in PATH. Please verify that agy is installed and accessible.`,
        {
          code: "BINARY_NOT_FOUND",
          details: { agyPath },
        }
      );
    }

    throw new CompatibilityError(
      `Failed to determine Antigravity CLI version: ${err instanceof Error ? err.message : String(err)}`,
      {
        code: "VERSION_CHECK_FAILED",
        details: { error: String(err) },
      }
    );
  }

  debugLog("version", `Detected Antigravity CLI version output: "${output}"`);

  const [major, minor, patch] = parseSemver(output);
  return { version: `${major}.${minor}.${patch}` };
}
