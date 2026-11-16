import { appendFileSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export interface AcpRegistryBinaryEntry {
  archive: string;
  cmd: string;
  args?: string[];
  sha256: string;
}

export interface AcpRegistry {
  id: string;
  name: string;
  version: string;
  description: string;
  website: string;
  authors: string[];
  license: string;
  license_url: string;
  distribution: {
    binary: Record<string, AcpRegistryBinaryEntry>;
  };
}

export type SyncRegistryResult =
  | { status: "skipped"; reason: string }
  | { status: "unchanged"; localVersion: string; upstreamVersion: string }
  | { status: "updated"; localVersion: string; upstreamVersion: string };

export interface SyncRegistryOptions {
  registryPath?: string;
  upstreamUrl?: string | undefined;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_REGISTRY_PATH = "src/extension/drivers/acp/registry.json";

const EXPECTED_ID = "antigravity-acp";
const TOP_LEVEL_KEYS = new Set([
  "id",
  "name",
  "version",
  "description",
  "website",
  "authors",
  "license",
  "license_url",
  "distribution",
]);
const BINARY_ENTRY_KEYS = new Set(["archive", "cmd", "args", "sha256"]);
const FETCH_TIMEOUT_MS = 10_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ACP registry: '${field}' must be a non-empty string.`);
  }
  return value;
}

function assertHttpsUrl(value: unknown, field: string): URL {
  const raw = assertNonEmptyString(value, field);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ACP registry: '${field}' is not a valid URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`Invalid ACP registry: '${field}' must be an HTTPS URL without credentials.`);
  }
  return url;
}

function validateBinaryEntry(platform: string, candidate: unknown): AcpRegistryBinaryEntry {
  if (!isPlainObject(candidate)) {
    throw new Error(`Invalid ACP registry: platform '${platform}' entry must be an object.`);
  }

  for (const key of Object.keys(candidate)) {
    if (!BINARY_ENTRY_KEYS.has(key)) {
      throw new Error(`Invalid ACP registry: platform '${platform}' contains unsupported field '${key}'.`);
    }
  }

  const archiveUrl = assertHttpsUrl(candidate.archive, `distribution.binary.${platform}.archive`);
  if (archiveUrl.hostname !== "dl.google.com" || archiveUrl.port) {
    throw new Error(`Invalid ACP registry: platform '${platform}' archive must use an official dl.google.com HTTPS URL.`);
  }
  const filename = path.posix.basename(archiveUrl.pathname);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/.test(filename)) {
    throw new Error(`Invalid ACP registry: platform '${platform}' archive filename '${filename}' must be a safe .zip filename.`);
  }

  const cmd = assertNonEmptyString(candidate.cmd, `distribution.binary.${platform}.cmd`);
  const executable = cmd.replace(/^\.\//, "");
  if (
    executable.length === 0 ||
    executable.includes("\\") ||
    executable.includes("\0") ||
    executable.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Invalid ACP registry: platform '${platform}' has unsafe command '${cmd}'.`);
  }

  const sha256 = assertNonEmptyString(candidate.sha256, `distribution.binary.${platform}.sha256`);
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`Invalid ACP registry: platform '${platform}' has invalid SHA-256 '${sha256}'.`);
  }

  if (candidate.args !== undefined) {
    if (!Array.isArray(candidate.args) || !candidate.args.every((arg) => typeof arg === "string" && !arg.includes("\0"))) {
      throw new Error(`Invalid ACP registry: platform '${platform}' args must be an array of strings without NUL bytes.`);
    }
  }

  return candidate as unknown as AcpRegistryBinaryEntry;
}

export function validateRegistry(candidate: unknown, expectedPlatforms: readonly string[]): AcpRegistry {
  if (!isPlainObject(candidate)) {
    throw new Error("Invalid ACP registry: root value must be a JSON object.");
  }

  for (const key of Object.keys(candidate)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new Error(`Invalid ACP registry: unsupported top-level field '${key}'.`);
    }
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!(key in candidate)) {
      throw new Error(`Invalid ACP registry: missing required top-level field '${key}'.`);
    }
  }

  if (candidate.id !== EXPECTED_ID) {
    throw new Error(`Invalid ACP registry: 'id' must be '${EXPECTED_ID}'.`);
  }
  assertNonEmptyString(candidate.name, "name");
  const version = assertNonEmptyString(candidate.version, "version");
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid ACP registry: 'version' ('${version}') must use X.Y.Z format.`);
  }
  assertNonEmptyString(candidate.description, "description");
  assertHttpsUrl(candidate.website, "website");
  assertNonEmptyString(candidate.license, "license");
  assertHttpsUrl(candidate.license_url, "license_url");

  if (!Array.isArray(candidate.authors) || candidate.authors.length === 0 ||
    !candidate.authors.every((author) => typeof author === "string" && author.trim().length > 0)) {
    throw new Error("Invalid ACP registry: 'authors' must be a non-empty array of strings.");
  }

  if (!isPlainObject(candidate.distribution)) {
    throw new Error("Invalid ACP registry: 'distribution' must be an object.");
  }
  const distKeys = Object.keys(candidate.distribution);
  if (distKeys.length !== 1 || distKeys[0] !== "binary" || !isPlainObject(candidate.distribution.binary)) {
    throw new Error("Invalid ACP registry: 'distribution' must contain only a 'binary' map.");
  }

  const binary = candidate.distribution.binary;
  const actualPlatforms = Object.keys(binary).sort();
  const sortedExpected = [...expectedPlatforms].sort();
  if (
    actualPlatforms.length !== sortedExpected.length ||
    actualPlatforms.some((platform, index) => platform !== sortedExpected[index])
  ) {
    throw new Error(
      `Invalid ACP registry: platform coverage mismatch (expected [${sortedExpected.join(", ")}], got [${actualPlatforms.join(", ")}]).`,
    );
  }

  for (const platform of sortedExpected) {
    validateBinaryEntry(platform, binary[platform]);
  }

  return candidate as unknown as AcpRegistry;
}

export function registriesEqual(local: AcpRegistry, upstream: AcpRegistry): boolean {
  return isDeepStrictEqual(local, upstream);
}

export async function fetchUpstreamRegistry(url: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<unknown> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid ACP_REGISTRY_UPSTREAM_URL: '${url}'.`);
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error(`Unsupported ACP_REGISTRY_UPSTREAM_URL protocol '${parsedUrl.protocol}'.`);
  }

  const response = await fetchImpl(parsedUrl.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Failed to fetch upstream ACP registry: HTTP ${response.status} ${response.statusText}`.trim());
  }

  const body = await response.text();
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Upstream ACP registry is not valid JSON: ${reason}`);
  }
}

async function writeRegistryAtomically(registryPath: string, registry: AcpRegistry): Promise<void> {
  const tempPath = path.join(
    path.dirname(registryPath),
    `.${path.basename(registryPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const formatted = `${JSON.stringify(registry, null, 2)}\n`;
  try {
    await writeFile(tempPath, formatted, "utf8");
    await rename(tempPath, registryPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function syncAcpRegistry(options: SyncRegistryOptions = {}): Promise<SyncRegistryResult> {
  const url = options.upstreamUrl?.trim();
  if (!url) {
    return { status: "skipped", reason: "ACP_REGISTRY_UPSTREAM_URL is not set." };
  }

  const registryPath = options.registryPath ?? DEFAULT_REGISTRY_PATH;
  const localRaw = await readFile(registryPath, "utf8");
  const localParsed = JSON.parse(localRaw) as unknown;
  if (!isPlainObject(localParsed) || !isPlainObject(localParsed.distribution) || !isPlainObject(localParsed.distribution.binary)) {
    throw new Error(`Local ACP registry at '${registryPath}' has invalid structure.`);
  }
  const expectedPlatforms = Object.keys(localParsed.distribution.binary);
  const local = validateRegistry(localParsed, expectedPlatforms);

  const upstreamRaw = await fetchUpstreamRegistry(url, options.fetchImpl);
  const upstream = validateRegistry(upstreamRaw, expectedPlatforms);

  if (registriesEqual(local, upstream)) {
    return { status: "unchanged", localVersion: local.version, upstreamVersion: upstream.version };
  }

  await writeRegistryAtomically(registryPath, upstream);
  return { status: "updated", localVersion: local.version, upstreamVersion: upstream.version };
}

function escapeWorkflowCommand(message: string): string {
  return message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function appendSummary(line: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, `${line}\n`);
  }
}

function writeOutputs(values: Record<string, string>): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  appendFileSync(outputPath, `${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  const upstreamUrl = process.env.ACP_REGISTRY_UPSTREAM_URL;
  try {
    const result = await syncAcpRegistry({ upstreamUrl });

    if (result.status === "skipped") {
      console.log(`::notice::${escapeWorkflowCommand(result.reason)} Skipping upstream check.`);
      appendSummary("- **ACP registry sync:** skipped (`ACP_REGISTRY_UPSTREAM_URL` is not set).");
      writeOutputs({ status: "skipped", changed: "false" });
      return;
    }

    if (result.status === "unchanged") {
      const msg = `ACP registry matches upstream (version ${result.localVersion}).`;
      console.log(msg);
      appendSummary(`- **ACP registry sync:** ${msg}`);
      writeOutputs({
        status: "unchanged",
        changed: "false",
        local_version: result.localVersion,
        upstream_version: result.upstreamVersion,
      });
      return;
    }

    const msg = `Updated local ACP registry from ${result.localVersion} to ${result.upstreamVersion}.`;
    console.log(msg);
    appendSummary(`- **ACP registry sync:** ${msg}`);
    writeOutputs({
      status: "updated",
      changed: "true",
      local_version: result.localVersion,
      upstream_version: result.upstreamVersion,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`::error title=ACP registry sync failed::${escapeWorkflowCommand(reason)}`);
    appendSummary(`- **ACP registry sync failed:** ${reason}`);
    writeOutputs({ status: "failed", changed: "false" });
    process.exitCode = 1;
  }
}

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (executedPath === fileURLToPath(import.meta.url)) {
  await main();
}
