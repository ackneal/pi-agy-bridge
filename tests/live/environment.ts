import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { ensureInstallation } from "../../src/extension/drivers/acp/installation.ts";
import { resolveRelease } from "../../src/extension/drivers/acp/release.ts";
import { ScenarioOutcome } from "./report.ts";

export type ExecutionMode = "isolated" | "local";

export function executionMode(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): ExecutionMode {
  if (env.PI_AGY_LIVE !== "1") throw new ScenarioOutcome("SKIP", "Set PI_AGY_LIVE=1 to opt in; see docs/live-acp.md");
  const mode = env.PI_AGY_LIVE_MODE ?? "isolated";
  assert.ok(mode === "isolated" || mode === "local", "PI_AGY_LIVE_MODE must be isolated or local");
  if (mode === "isolated") {
    if (platform !== "linux" || env.PI_AGY_LIVE_ISOLATED !== "1") {
      throw new ScenarioOutcome("SKIP", "Use a disposable Linux container with no host credentials, directories or keyring mounted; attest PI_AGY_LIVE_ISOLATED=1");
    }
    return mode;
  }
  if (platform !== "darwin" || env.PI_AGY_LIVE_LOCAL !== "1") {
    throw new ScenarioOutcome("SKIP", "Local mode requires macOS and PI_AGY_LIVE_LOCAL=1: consent to host login reuse, backend credential/cache/session writes and billable prompts; this is not a sandbox");
  }
  assert.notEqual(env.PI_AGY_LIVE_ISOLATED, "1", "Local execution cannot attest isolation");
  assert.ok(env.PI_AGY_LIVE_SCENARIOS?.trim(), "Local mode requires an explicit PI_AGY_LIVE_SCENARIOS selection");
  assert.notEqual(env.PI_AGY_LIVE_AUTH_STATE, "unauthenticated", "Local mode cannot manufacture or test negative authentication");
  assert.notEqual(env.PI_AGY_LIVE_LOGIN, "1", "Interactive login is disabled in local mode");
  assert.ok(!env.AGY_ACP_DIR?.trim() && !env.AGY_ACP_BIN?.trim(), "Unset ACP executable overrides; local tests require the pinned managed release");
  return mode;
}

export function localScenarioRestriction(id: string): string | undefined {
  if (["AUTH-noauth", "AUTH-login", "AUTH-login-cancel", "B-native", "READ-scope"].includes(id)) {
    return "This scenario requires the isolated Linux environment; local mode does not test authentication mutation, native escape attempts or seeded host reader boundaries";
  }
  return undefined;
}

export async function prepareLiveEnvironment(options: {
  reportDirectory: string;
  signal: AbortSignal;
  timeoutMs: number;
  environment: Record<string, string>;
}) {
  const mode = executionMode();
  const { environment, signal, timeoutMs, reportDirectory } = options;
  environment.execution = mode === "local" ? "local-host-not-sandboxed" : "isolated-linux-attested";
  const temporaryRoot = await realpath(tmpdir());
  let workspace: string;
  let home: string;
  let gemini: string;
  if (mode === "local") {
    // Inspect directory metadata only. Never read, copy or rewrite credentials.
    home = await realpath(process.env.HOME ?? homedir());
    gemini = await realpath(process.env.GEMINI_HOME ?? path.join(home, ".gemini"));
    assert.ok(path.isAbsolute(home) && (await lstat(home)).isDirectory(), "Local HOME must be a real directory");
    const stat = await lstat(gemini);
    assert.ok(stat.isDirectory() && stat.uid === process.getuid?.(), "Local GEMINI_HOME must be an existing current-user-owned directory");
    workspace = temporaryRoot;
  } else {
    const supplied = process.env.PI_AGY_LIVE_WORKSPACE;
    if (!supplied || !path.isAbsolute(supplied) || await realpath(supplied) !== supplied ||
        !supplied.startsWith(temporaryRoot + path.sep) || (await lstat(supplied)).uid !== process.getuid?.()) {
      throw new ScenarioOutcome("SKIP", "Provide PI_AGY_LIVE_WORKSPACE: an owned, real directory below the container temporary directory, with externally authenticated home/ and gemini/");
    }
    workspace = supplied;
    home = path.join(workspace, "home");
    gemini = path.join(workspace, "gemini");
    for (const directory of [home, gemini]) {
      if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) {
        throw new ScenarioOutcome("SKIP", "Prepare real workspace/home and workspace/gemini directories externally");
      }
    }
    assert.ok(!reportDirectory.startsWith(workspace + path.sep), "Keep reports outside the disposable workspace");
  }
  if (process.env.PI_AGY_LIVE_INSTALL !== "1") throw new ScenarioOutcome("SKIP", "Set PI_AGY_LIVE_INSTALL=1 to consent to a managed pinned ACP download into disposable scratch storage");
  signal.throwIfAborted();
  const scratch = await mkdtemp(path.join(workspace, "pi-agy-live-run-"));
  try {
    process.env.HOME = home;
    process.env.GEMINI_HOME = gemini;
    process.env.PI_CODING_AGENT_DIR = path.join(scratch, "agent");
    for (const key of Object.keys(process.env)) {
      if (/^(AGY_|PI_AGY_DEBUG|GOOGLE_|GEMINI_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY)/.test(key) || mode === "isolated" && key.startsWith("XDG_")) delete process.env[key];
    }
    if (mode === "isolated") {
      process.env.XDG_CONFIG_HOME = path.join(scratch, "config");
      process.env.XDG_CACHE_HOME = path.join(scratch, "cache");
      process.env.XDG_DATA_HOME = path.join(scratch, "data");
    }
    const release = resolveRelease();
    environment.acp = release.version;
    environment.distribution = release.platform;
    const launch = await ensureInstallation({ agentHome: process.env.PI_CODING_AGENT_DIR, signal });
    const cwd = path.join(scratch, "project");
    await mkdir(cwd);
    return { scratch, mode, connection: { ...launch, cwd, requestTimeoutMs: Math.min(timeoutMs, 60_000) } };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}
