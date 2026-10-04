import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CompatibilityError } from "../shared/types.ts";
import { debugLog } from "../shared/debug.ts";

const execFileAsync = promisify(execFile);

export const DEFAULT_MIN_AGY_VERSION = "1.1.15";

export function resolveAgyExecutable(customPath?: string): string {
  if (customPath && customPath !== "agy") {
    return customPath;
  }

  const standardLocal = path.join(os.homedir(), ".local", "bin", "agy");
  if (fs.existsSync(standardLocal)) {
    return standardLocal;
  }

  return "agy";
}

export function parseSemver(versionStr: string): [number, number, number] {
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

export function compareSemver(v1: string, v2: string): number {
  const [maj1, min1, pat1] = parseSemver(v1);
  const [maj2, min2, pat2] = parseSemver(v2);

  if (maj1 !== maj2) return maj1 - maj2;
  if (min1 !== min2) return min1 - min2;
  return pat1 - pat2;
}

export function isVersionSupported(candidate: string, minVersion: string = DEFAULT_MIN_AGY_VERSION): boolean {
  return compareSemver(candidate, minVersion) >= 0;
}

export async function validateAgyVersion(
  agyPath: string = "agy",
  minVersion: string = DEFAULT_MIN_AGY_VERSION
): Promise<{ valid: boolean; version: string }> {
  const resolvedPath = resolveAgyExecutable(agyPath);

  let output: string;
  try {
    const { stdout, stderr } = await execFileAsync(resolvedPath, ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    output = (stdout || stderr).trim();
  } catch (err: unknown) {
    if (err instanceof CompatibilityError) {
      throw err;
    }

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

  debugLog("version", `Detected agy version output: "${output}"`);

  const [major, minor, patch] = parseSemver(output);
  const parsedVersion = `${major}.${minor}.${patch}`;

  if (!isVersionSupported(parsedVersion, minVersion)) {
    throw new CompatibilityError(
      `Antigravity CLI version ${parsedVersion} is unsupported. Minimum required version is ${minVersion}. Please upgrade agy.`,
      {
        code: "VERSION_TOO_OLD",
        details: { currentVersion: parsedVersion, minVersion },
      }
    );
  }

  return { valid: true, version: parsedVersion };
}
