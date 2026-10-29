import cp from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { debugLog } from "../shared/debug.ts";
import { resolveAgyExecutable } from "./version.ts";
import { recordAuthProbeDiagnostics, summarizeAuthOutput } from "./auth-diagnostics.ts";
import { AuthenticationRequiredError } from "../shared/types.ts";

function runUsageQuery(file: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  const args = ["--output-format", "json", "--print", "/usage"];

  return new Promise((resolve, reject) => {
    const child = cp.spawn(file, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const streams = { stdout: "", stderr: "" };
    const bytes = { stdout: 0, stderr: 0 };
    const limit = 1024 * 1024;
    let failure: Error | undefined;

    const kill = () => {
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* The owned process group has already exited. */ }
    };
    const stop = (error: Error) => {
      failure ??= error;
      kill();
    };
    const abort = () => {
      failure = Object.assign(new Error("The operation was aborted", { cause: signal?.reason }), {
        name: "AbortError", code: "ABORT_ERR",
      });
      kill();
    };
    const inspect = (stream: keyof typeof streams) => (chunk: string) => {
      bytes[stream] += Buffer.byteLength(chunk);
      if (failure) return;
      const output = streams[stream].slice(-4096) + chunk;
      if (bytes[stream] <= limit) streams[stream] += chunk;
      if (/authentication required/i.test(stripVTControlCharacters(output))) {
        stop(new AuthenticationRequiredError());
      } else if (bytes[stream] > limit) {
        stop(Object.assign(new RangeError(`${stream} maxBuffer length exceeded`), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
      }
    };
    const stdout = inspect("stdout");
    const stderr = inspect("stderr");
    const timer = setTimeout(() => stop(Object.assign(new Error("Command timed out after 30 seconds"), {
      code: "ETIMEDOUT",
    })), 30_000);

    child.stdout.setEncoding("utf8").on("data", stdout);
    child.stderr.setEncoding("utf8").on("data", stderr);
    child.on("error", stop);
    child.once("exit", kill);
    signal?.addEventListener("abort", abort, { once: true });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.stdout.off("data", stdout);
      child.stderr.off("data", stderr);
      child.off("error", stop);
      child.off("exit", kill);
      kill();

      recordAuthProbeDiagnostics(import.meta.url, file, args, code, exitSignal, streams, bytes);
      if (!failure && (code !== 0 || exitSignal)) failure = new Error(`Command failed: ${file} ${args.join(" ")}`);
      if (failure) {
        Object.assign(failure, streams, { signal: exitSignal });
        if (!("code" in failure)) Object.assign(failure, { code });
        reject(failure);
      } else {
        resolve(streams);
      }
    });
    if (signal?.aborted) abort();
  });
}

export interface AgyQuotaBucket {
  id: string;
  name: string;
  window: string;
  remainingFraction: number;
  resetTime?: string | undefined;
}

export interface AgyQuotaGroup {
  name: string;
  description?: string | undefined;
  buckets: AgyQuotaBucket[];
}

export interface AgyUsage {
  updatedAt: string;
  groups: AgyQuotaGroup[];
}

function normalizeWindow(name: string, rawWindow?: string): string {
  if (typeof rawWindow === "string" && rawWindow.trim().length > 0) return rawWindow.trim();
  if (/five hour|5[- ]?hour|5h/i.test(name)) return "5h";
  if (/weekly/i.test(name)) return "weekly";
  return name.trim().toLowerCase();
}

function parseJsonUsage(text: string, updatedAt: string): AgyUsage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const command = record.command && typeof record.command === "object"
    ? record.command as Record<string, unknown>
    : undefined;
  const data = command?.data && typeof command.data === "object"
    ? command.data as Record<string, unknown>
    : undefined;

  if (Array.isArray(data?.groups)) {
    const groups: AgyQuotaGroup[] = [];
    for (const rawGroup of data.groups) {
      if (!rawGroup || typeof rawGroup !== "object") continue;
      const groupRecord = rawGroup as Record<string, unknown>;
      if (typeof groupRecord.name !== "string" || !groupRecord.name.trim()) continue;

      const buckets: AgyQuotaBucket[] = [];
      for (const rawBucket of Array.isArray(groupRecord.buckets) ? groupRecord.buckets : []) {
        if (!rawBucket || typeof rawBucket !== "object") continue;
        const bucketRecord = rawBucket as Record<string, unknown>;
        const fraction = bucketRecord.remaining_fraction;
        if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;

        const name = typeof bucketRecord.name === "string" && bucketRecord.name.trim()
          ? bucketRecord.name.trim()
          : "Limit Remaining";
        const window = normalizeWindow(name, typeof bucketRecord.window === "string" ? bucketRecord.window : undefined);
        const id = typeof bucketRecord.id === "string" && bucketRecord.id.trim()
          ? bucketRecord.id.trim()
          : `${groupRecord.name}-${window}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const resetTime = typeof bucketRecord.reset_time === "string" && bucketRecord.reset_time.trim()
          ? bucketRecord.reset_time.trim()
          : undefined;

        buckets.push({ id, name, window, remainingFraction: fraction, ...(resetTime ? { resetTime } : {}) });
      }

      if (buckets.length === 0) continue;
      const description = typeof groupRecord.description === "string" && groupRecord.description.trim()
        ? groupRecord.description.trim()
        : undefined;
      groups.push({ name: groupRecord.name.trim(), ...(description ? { description } : {}), buckets });
    }

    if (groups.length > 0) return { updatedAt, groups };
  }

  return typeof record.response === "string" ? parseTextUsage(record.response, updatedAt) : undefined;
}

function parseTextUsage(text: string, updatedAt: string): AgyUsage | undefined {
  const groupsByName = new Map<string, AgyQuotaGroup>();

  for (const rawLine of text.split(/[\r\n]+/)) {
    const line = rawLine.trim();
    if (!line || /^quota:?$/i.test(line)) continue;

    const match = line.match(/^(.+?)(?:\t+| {2,})(.+?)(?:\t+| {2,}|\s+)(\d{1,3})%(?:(?:\t+| {2,}|\s+)(.+))?$/);
    if (!match) continue;

    const groupName = match[1]!.trim();
    const bucketName = match[2]!.trim();
    const percent = Number(match[3]);
    const resetTime = match[4]?.trim();
    if (!groupName || !bucketName || !Number.isFinite(percent) || percent < 0 || percent > 100) continue;

    const window = normalizeWindow(bucketName);
    const id = `${groupName}-${window}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    let group = groupsByName.get(groupName);
    if (!group) {
      group = { name: groupName, buckets: [] };
      groupsByName.set(groupName, group);
    }

    group.buckets.push({
      id,
      name: bucketName,
      window,
      remainingFraction: percent / 100,
      ...(resetTime ? { resetTime } : {}),
    });
  }

  return groupsByName.size > 0 ? { updatedAt, groups: [...groupsByName.values()] } : undefined;
}

export function parseAgyUsageOutput(output: string, updatedAt: string = new Date().toISOString()): AgyUsage | undefined {
  const cleaned = stripVTControlCharacters(output).trim();
  if (!cleaned) return undefined;

  return parseJsonUsage(cleaned, updatedAt) ?? parseTextUsage(cleaned, updatedAt);
}

function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function formatResetCountdown(resetTime: string | undefined, nowMs: number): string | undefined {
  if (!resetTime || !/(?:Z|[+-]\d{2}:\d{2})$/.test(resetTime)) return undefined;
  const targetMs = Date.parse(resetTime);
  if (!Number.isFinite(targetMs)) return undefined;

  const diffMinutes = Math.max(0, Math.round((targetMs - nowMs) / 60_000));
  const days = Math.floor(diffMinutes / (60 * 24));
  const hours = Math.floor((diffMinutes % (60 * 24)) / 60);
  const minutes = diffMinutes % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function formatBucketSummary(bucket: AgyQuotaBucket, nowMs: number): string {
  const reset = formatResetCountdown(bucket.resetTime, nowMs);
  return `${bucket.window} ${formatPercent(bucket.remainingFraction)}${reset ? ` (${reset})` : ""}`;
}

export function formatDoctorQuotaLines(usage: AgyUsage | undefined, nowMs: number = Date.now()): string[] {
  if (!usage || usage.groups.length === 0) return [];

  const lines = ["", "Quota remaining"];
  const order = (window: string) => window === "5h" ? 0 : window === "weekly" ? 1 : 2;
  const width = Math.max(...usage.groups.map((group) => group.name.length));

  for (const group of usage.groups) {
    const buckets = [...group.buckets]
      .sort((a, b) => order(a.window) - order(b.window))
      .map((bucket) => formatBucketSummary(bucket, nowMs));
    lines.push(`  ${group.name.padEnd(width)}  ${buckets.join(" · ")}`);
  }

  return lines;
}

export async function fetchAgyUsage(
  agyPath: string = "agy",
  signal?: AbortSignal
): Promise<AgyUsage> {
  signal?.throwIfAborted();
  const resolvedPath = resolveAgyExecutable(agyPath);

  let output = "";
  try {
    const { stdout, stderr } = await runUsageQuery(resolvedPath, signal);
    output = (stdout || stderr || "").trim();
  } catch (error) {
    if (signal?.aborted || error instanceof AuthenticationRequiredError) throw error;
    const failure = error as { code?: string | number; stdout?: string; stderr?: string };
    const reason = failure.code === "ETIMEDOUT" ? "timed out after 30 seconds"
      : failure.code === "ENOENT" ? "executable not found"
      : failure.code === "EACCES" ? "permission denied"
      : `process failed (exit ${failure.code ?? "unknown"})`;
    const diagnostics = summarizeAuthOutput(String(failure.stderr || failure.stdout || "")).trim();
    throw new Error(
      `Antigravity CLI quota query ${reason}${diagnostics ? `: ${diagnostics}` : ""}. Check agy installation and run /login if authentication is required.`,
      { cause: error }
    );
  }

  const usage = parseAgyUsageOutput(output);
  if (!usage) {
    throw new Error(`Antigravity CLI returned no quota data from "${resolvedPath} --output-format json --print /usage"`);
  }

  debugLog("usage", `Fetched ${usage.groups.length} quota groups from Antigravity CLI`);
  return usage;
}
