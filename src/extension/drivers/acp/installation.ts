import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { extractAcpArchive } from "./archive.ts";
import { ACP_REQUIRED_EXECUTABLES, acpDistributionName, resolveAcpRelease, type AcpRelease } from "./release.ts";
import { debugLog } from "../../shared/debug.ts";

export interface AcpInstallProgress {
  phase: "download" | "verify" | "extract" | "validate" | "complete" | "error" | "cancelled";
  version: string;
  platform: string;
  message: string;
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface AcpLaunch { executable: string; args: string[] }

interface InstallationOptions {
  signal?: AbortSignal;
  onProgress?: (progress: AcpInstallProgress) => void;
  agentHome?: string;
  release?: AcpRelease;
  fetch?: typeof globalThis.fetch;
}

type InventoryEntry = { path: string; mode: number } & (
  { type: "file"; size: number; sha256: string } |
  { type: "directory" }
);
interface InstallationManifest {
  schema: 1;
  version: string;
  platform: string;
  sha256: string;
  files: InventoryEntry[];
}
interface Job {
  controller: AbortController;
  promise: Promise<AcpLaunch>;
  listeners: Set<(progress: AcpInstallProgress) => void>;
  consumers: Set<symbol>;
  last?: AcpInstallProgress;
}

const MANIFEST = ".pi-agy-installation.json";
const jobs = new Map<string, Job>();
// Rehash on the first use in each process; subsequent uses still check every file's identity and metadata.
const validated = new Map<string, string>();

function installationRoot(agentHome: string): string {
  return path.join(path.resolve(agentHome), "pi-agy-bridge", "acp");
}

function installationDirectory(agentHome: string, release: AcpRelease): string {
  return path.join(installationRoot(agentHome), acpDistributionName(release));
}

function safeRelative(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes("\0") &&
    value.split("/").every((component) => component !== "" && component !== "." && component !== "..");
}

function matchesRelease(manifest: InstallationManifest, release: AcpRelease): boolean {
  return manifest.schema === 1 && manifest.version === release.version && manifest.platform === release.platform &&
    manifest.sha256 === release.sha256 && Array.isArray(manifest.files) && manifest.files.length > 0;
}

function notify(listener: ((progress: AcpInstallProgress) => void) | undefined, progress: AcpInstallProgress): void {
  try { listener?.(progress); }
  catch (error) { debugLog("acp-install", "Could not display installation progress:", error); }
}

async function hashFile(filename: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(filename), hash, { signal });
  return hash.digest("hex");
}

async function inventory(directory: string, signal: AbortSignal, hash: boolean): Promise<{ files: InventoryEntry[]; stamp: string }> {
  const files: InventoryEntry[] = [];
  const stamps: unknown[] = [];
  const visit = async (relative: string): Promise<void> => {
    const names = (await fsp.readdir(path.join(directory, relative))).sort();
    for (const name of names) {
      signal.throwIfAborted();
      if (!relative && name === MANIFEST) continue;
      const filepath = relative ? `${relative}/${name}` : name;
      if (!safeRelative(filepath)) throw new Error(`Unsafe ACP installation entry: ${filepath}`);
      const absolute = path.join(directory, filepath);
      const stat = await fsp.lstat(absolute, { bigint: true });
      const mode = Number(stat.mode & 0o777n);
      stamps.push([filepath, stat.dev.toString(), stat.ino.toString(), stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString(), mode]);
      if (stat.isDirectory()) {
        files.push({ path: filepath, type: "directory", mode });
        await visit(filepath);
      } else if (stat.isFile()) {
        files.push({ path: filepath, type: "file", mode, size: Number(stat.size), sha256: hash ? await hashFile(absolute, signal) : "" });
      } else {
        throw new Error(`Unsupported ACP installation entry: ${filepath}`);
      }
    }
  };
  await visit("");
  const stat = await fsp.lstat(path.join(directory, MANIFEST), { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  stamps.push(stat ? [stat.ino.toString(), stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString()] : null);
  return { files, stamp: JSON.stringify(stamps) };
}

async function validateInstallation(directory: string, release: AcpRelease, signal: AbortSignal, onValidate: () => void): Promise<boolean> {
  signal.throwIfAborted();
  try {
    if (!(await fsp.lstat(directory)).isDirectory() || !(await fsp.lstat(path.join(directory, MANIFEST))).isFile()) return false;
    const manifest: InstallationManifest = JSON.parse(await fsp.readFile(path.join(directory, MANIFEST), "utf8"));
    if (!matchesRelease(manifest, release)) return false;
    if (!manifest.files.every((entry) => safeRelative(entry.path))) return false;
    const snapshot = await inventory(directory, signal, false);
    if (validated.get(directory) === snapshot.stamp) return true;
    if (snapshot.files.length !== manifest.files.length) return false;

    const expected = new Map(manifest.files.map((entry) => [entry.path, entry]));
    if (expected.size !== manifest.files.length) return false;
    onValidate();
    for (const file of snapshot.files) {
      const recorded = expected.get(file.path);
      if (!recorded || file.type !== recorded.type || file.mode !== recorded.mode) return false;
      if (file.type === "file" && recorded.type === "file" &&
        (file.size !== recorded.size || await hashFile(path.join(directory, file.path), signal) !== recorded.sha256)) return false;
    }
    for (const required of ACP_REQUIRED_EXECUTABLES) {
      const file = expected.get(required);
      if (file?.type !== "file" || !(file.mode & 0o111)) return false;
      await fsp.access(path.join(directory, required), fs.constants.X_OK);
    }
    validated.set(directory, snapshot.stamp);
    return true;
  } catch (error) {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "EACCES") throw error;
    return false;
  }
}

/** A read-only status hint. Launch resolution separately checks complete installation integrity. */
export function findAcpInstallation(): string | undefined {
  try {
    const release = resolveAcpRelease();
    const directory = installationDirectory(getAgentDir(), release);
    if (!fs.lstatSync(directory).isDirectory()) return undefined;
    const manifest: InstallationManifest = JSON.parse(fs.readFileSync(path.join(directory, MANIFEST), "utf8"));
    if (!matchesRelease(manifest, release)) return undefined;
    const executable = path.join(directory, release.executable);
    if (!fs.lstatSync(executable).isFile()) return undefined;
    fs.accessSync(executable, fs.constants.X_OK);
    return executable;
  } catch { return undefined; }
}

async function prepareInstallationRoot(agentHome: string): Promise<string> {
  await fsp.mkdir(agentHome, { recursive: true });
  const home = await fsp.realpath(agentHome);
  let current = home;
  for (const component of ["pi-agy-bridge", "acp"]) {
    current = path.join(current, component);
    try { await fsp.mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!(await fsp.lstat(current)).isDirectory()) throw new Error(`ACP installation path must be a directory, not a symlink: ${current}`);
  }
  return current;
}

async function publishDistribution(source: string, directory: string, manifest: InstallationManifest, release: AcpRelease,
  signal: AbortSignal, onValidate: () => void): Promise<void> {
  signal.throwIfAborted();
  const existing = await fsp.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!existing) {
    try {
      await fsp.rename(source, directory);
      return;
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  if (await validateInstallation(directory, release, signal, onValidate)) return;
  if (!(await fsp.lstat(directory)).isDirectory()) throw new Error(`ACP installation is not a regular directory: ${directory}`);

  const previous: InstallationManifest | undefined = await fsp.readFile(path.join(directory, MANIFEST), "utf8")
    .then((text) => { try { return JSON.parse(text) as InstallationManifest; } catch { return undefined; } },
      (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (previous?.schema === 1 && typeof previous.sha256 === "string" &&
    (previous.version !== release.version || previous.platform !== release.platform || previous.sha256 !== release.sha256)) {
    throw new Error(`ACP installation belongs to a different pinned archive: ${directory}. Use a distinct official archive filename; do not replace a running release in place`);
  }

  // Same-pin repair replaces files atomically; never move or remove a directory another process may be using.
  const directories = manifest.files.filter((entry) => entry.type === "directory");
  for (const entry of directories) {
    signal.throwIfAborted();
    const target = path.join(directory, entry.path);
    try { await fsp.mkdir(target, { mode: entry.mode | 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!(await fsp.lstat(target)).isDirectory()) throw new Error(`Unsafe ACP installation directory: ${target}`);
    await fsp.chmod(target, entry.mode | 0o700);
  }
  for (const entry of manifest.files) {
    signal.throwIfAborted();
    if (entry.type === "file") await fsp.rename(path.join(source, entry.path), path.join(directory, entry.path));
  }
  for (const entry of directories.reverse()) await fsp.chmod(path.join(directory, entry.path), entry.mode);
  signal.throwIfAborted();
  await fsp.rename(path.join(source, MANIFEST), path.join(directory, MANIFEST));
  if (!await validateInstallation(directory, release, signal, onValidate)) {
    throw new Error(`ACP installation still contains damaged or unexpected files: ${directory}. Check its contents and permissions before retrying`);
  }
}

function downloadMessage(release: AcpRelease, bytes: number, total?: number): string {
  const size = `${(bytes / 1048576).toFixed(1)} MiB`;
  const amount = total ? `${size} / ${(total / 1048576).toFixed(1)} MiB (${Math.min(100, Math.floor(bytes * 100 / total))}%)` : size;
  return `Downloading Antigravity ACP ${release.version} (${release.platform}): ${amount}`;
}

async function downloadArchive(filename: string, release: AcpRelease, fetcher: typeof fetch, signal: AbortSignal,
  progress: (progress: AcpInstallProgress) => void): Promise<void> {
  const idle = new AbortController();
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(new Error("ACP download stalled for 60 seconds; check your connection and retry")), 60_000);
    timer.unref();
  };
  let timer: NodeJS.Timeout;
  reset();
  const bounded = AbortSignal.any([signal, idle.signal, AbortSignal.timeout(30 * 60_000)]);
  let bytes = 0;
  const hash = createHash("sha256");
  const emit = (total?: number) => progress({ phase: "download", version: release.version, platform: release.platform,
    message: downloadMessage(release, bytes, total), downloadedBytes: bytes, ...(total ? { totalBytes: total } : {}) });
  try {
    emit();
    const response = await fetcher(release.url, { signal: bounded, redirect: "error" });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Google download returned HTTP ${response.status}; retry or set AGY_ACP_BIN`);
    }
    const length = Number(response.headers.get("content-length"));
    const total = Number.isSafeInteger(length) && length > 0 ? length : undefined;
    let last = 0;
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 ** 3) { callback(new Error("ACP archive exceeds the 2 GiB download limit")); return; }
      hash.update(chunk);
      reset();
      if (Date.now() - last >= 200) { emit(total); last = Date.now(); }
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), meter,
      fs.createWriteStream(filename, { flags: "wx", mode: 0o600 }), { signal: bounded });
    emit(total);
    progress({ phase: "verify", version: release.version, platform: release.platform, message: `Verifying ACP ${release.version} archive SHA-256` });
    const actual = hash.digest("hex");
    if (actual !== release.sha256) throw new Error(`ACP archive SHA-256 mismatch: expected ${release.sha256}, received ${actual}. Nothing was installed; retry or set AGY_ACP_BIN.`);
  } catch (error) {
    if (idle.signal.aborted) throw idle.signal.reason;
    if (bounded.aborted && !signal.aborted) throw new Error("ACP download exceeded 30 minutes; retry on a faster connection or set AGY_ACP_BIN", { cause: error });
    throw error;
  } finally { clearTimeout(timer!); }
}

async function install(options: InstallationOptions, signal: AbortSignal, emit: (progress: AcpInstallProgress) => void): Promise<AcpLaunch> {
  const release = options.release ?? resolveAcpRelease();
  const agentHome = path.resolve(options.agentHome ?? getAgentDir());
  let staging: string | undefined;
  const progress = (phase: AcpInstallProgress["phase"], message: string) => emit({ phase, message, version: release.version, platform: release.platform });
  try {
    signal.throwIfAborted();
    const root = await prepareInstallationRoot(agentHome);
    const directory = path.join(root, acpDistributionName(release));
    let checking = false;
    const onValidate = () => {
      checking = true;
      progress("validate", `Checking installed Antigravity ACP ${release.version} files; no download needed unless damaged`);
    };
    if (await validateInstallation(directory, release, signal, onValidate)) {
      signal.throwIfAborted();
      if (checking) progress("complete", `Installed Antigravity ACP ${release.version} is ready`);
      return { executable: path.join(directory, release.executable), args: [...release.args] };
    }
    staging = await fsp.mkdtemp(path.join(root, ".staging-"));
    const archive = path.join(staging, "archive.zip");
    await downloadArchive(archive, release, options.fetch ?? globalThis.fetch, signal, emit);
    signal.throwIfAborted();
    const distribution = path.join(staging, "distribution");
    await fsp.mkdir(distribution, { mode: 0o700 });
    progress("extract", `Extracting ACP ${release.version}; this may take a moment`);
    await extractAcpArchive(archive, distribution, signal);
    signal.throwIfAborted();
    progress("validate", `Checking ACP ${release.version} files and executable permissions`);
    const { files } = await inventory(distribution, signal, true);
    for (const required of ACP_REQUIRED_EXECUTABLES) {
      const entry = files.find((file) => file.path === required);
      if (entry?.type !== "file" || !(entry.mode & 0o111)) throw new Error(`ACP distribution is missing required executable ${required}; nothing was installed`);
      await fsp.access(path.join(distribution, required), fs.constants.X_OK);
    }
    const manifest: InstallationManifest = { schema: 1, version: release.version, platform: release.platform, sha256: release.sha256, files };
    await fsp.writeFile(path.join(distribution, MANIFEST), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    signal.throwIfAborted();

    await publishDistribution(distribution, directory, manifest, release, signal, onValidate);
    const snapshot = await inventory(directory, signal, false);
    validated.set(directory, snapshot.stamp);
    progress("complete", `Antigravity ACP ${release.version} is ready`);
    return { executable: path.join(directory, release.executable), args: [...release.args] };
  } catch (error) {
    if (signal.aborted) {
      progress("cancelled", "Antigravity ACP installation cancelled; retry to start again");
      throw signal.reason;
    }
    const cause = error instanceof Error ? error.message : String(error);
    const message = `Could not prepare Antigravity ACP ${release.version}: ${cause}. Installation: ${installationDirectory(agentHome, release)}. Check network access, free disk space, and installation directory permissions, then retry; or set AGY_ACP_BIN.`;
    progress("error", message);
    throw new Error(message, { cause: error });
  } finally {
    if (staging) await fsp.rm(staging, { recursive: true, force: true }).catch((error) => debugLog("acp-install", "Could not clean unpublished ACP staging:", error));
  }
}

/** Share work in this process. Other processes publish to the same manifest-derived path without locks. */
export function ensureAcpInstallation(options: InstallationOptions = {}): Promise<AcpLaunch> {
  options.signal?.throwIfAborted();
  const release = options.release ?? resolveAcpRelease();
  const key = `${installationDirectory(options.agentHome ?? getAgentDir(), release)}:${release.sha256}`;
  let job = jobs.get(key);
  if (!job) {
    const controller = new AbortController();
    const listeners = new Set<(progress: AcpInstallProgress) => void>();
    const consumers = new Set<symbol>();
    const created: Job = { controller, listeners, consumers, promise: Promise.resolve().then(() => install(options, controller.signal, (progress) => {
      created.last = progress;
      for (const listener of listeners) notify(listener, progress);
    })) };
    job = created;
    jobs.set(key, job);
    void job.promise.finally(() => { if (jobs.get(key) === created) jobs.delete(key); }).catch(() => {});
  }
  const shared = job;
  const consumer = Symbol();
  shared.consumers.add(consumer);
  const onProgress = options.onProgress;
  const listener = onProgress ? (progress: AcpInstallProgress) => onProgress(progress) : undefined;
  if (listener) {
    shared.listeners.add(listener);
    if (shared.last) notify(listener, shared.last);
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      shared.consumers.delete(consumer);
      if (listener) shared.listeners.delete(listener);
      options.signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      if (!shared.consumers.size) {
        shared.controller.abort(options.signal?.reason);
        if (jobs.get(key) === shared) jobs.delete(key);
        notify(options.onProgress, { phase: "cancelled", version: release.version, platform: release.platform, message: "ACP preparation cancelled" });
      }
      reject(options.signal?.reason);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    shared.promise.then((launch) => { cleanup(); resolve(launch); }, (error: unknown) => { cleanup(); reject(error); });
    if (options.signal?.aborted) abort();
  });
}
