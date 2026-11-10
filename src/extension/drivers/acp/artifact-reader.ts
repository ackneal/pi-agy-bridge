import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { readTextPage, readTextPageChunks } from "./text-page.ts";
import { debugLog } from "../../shared/debug.ts";

interface Options {
  home: string;
  sessionId: () => string;
  allowedToolNames?: ReadonlySet<string>;
  observeImage: (image: { data: string; mimeType: string }, signal: AbortSignal) => Promise<string>;
}
interface FileIdentity {
  stat: Stats;
  ancestors: Array<{ name: string; stat: Stats }>;
}
type Artifact = { kind: "text"; identity: FileIdentity } | { kind: "snapshot"; text: string };
interface Prompt {
  controller: AbortController;
  artifacts: Map<string, Promise<Artifact>>;
  pending: Set<Promise<acp.ReadTextFileResponse>>;
  requests: number;
}

const READ_CHUNK_BYTES = 128 * 1024;

async function readBytes(fd: FileHandle, size: number, signal: AbortSignal): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    signal.throwIfAborted();
    const result = await fd.read(bytes, offset, size - offset, offset);
    signal.throwIfAborted();
    if (!result.bytesRead) throw new Error("Artifact shortened during read");
    offset += result.bytesRead;
  }
  return bytes;
}

async function* readChunks(fd: FileHandle, size: number, signal: AbortSignal): AsyncGenerator<Buffer> {
  const bytes = Buffer.alloc(Math.min(size, READ_CHUNK_BYTES));
  let offset = 0;
  while (offset < size) {
    signal.throwIfAborted();
    const result = await fd.read(bytes, 0, Math.min(bytes.length, size - offset), offset);
    signal.throwIfAborted();
    if (!result.bytesRead) throw new Error("Artifact shortened during read");
    offset += result.bytesRead;
    yield bytes.subarray(0, result.bytesRead);
  }
}
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function same(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.ctimeMs === b.ctimeMs && a.mtimeMs === b.mtimeMs && a.nlink === b.nlink;
}
function mime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** Best-effort identity checks under a trusted local directory owner, not a
 * race-free sandbox against hostile same-UID directory replacement. */
export class ArtifactReader {
  private readonly options: Options;
  private prompt: Prompt | undefined;

  constructor(options: Options) {
    this.options = { ...options, allowedToolNames: new Set(options.allowedToolNames ?? []) };
  }

  beginPrompt(): void {
    if (this.prompt) throw new Error("Previous artifact prompt must finish cleanup before starting another");
    this.prompt = { controller: new AbortController(), artifacts: new Map(), pending: new Set(), requests: 0 };
  }

  async endPrompt(): Promise<void> {
    const prompt = this.prompt;
    if (!prompt) return;
    prompt.controller.abort(new Error("Artifact prompt ended"));
    await Promise.allSettled(prompt.pending);
    if (this.prompt === prompt) this.prompt = undefined;
  }

  async read(request: acp.ReadTextFileRequest, connectionSignal: AbortSignal): Promise<acp.ReadTextFileResponse> {
    const prompt = this.prompt;
    if (!prompt) throw new Error("No active artifact prompt");
    const work = this.readRequest(request, connectionSignal, prompt);
    prompt.pending.add(work);
    try {
      return await work;
    } finally {
      prompt.pending.delete(work);
    }
  }

  private async readRequest(request: acp.ReadTextFileRequest, connectionSignal: AbortSignal, prompt: Prompt): Promise<acp.ReadTextFileResponse> {
    const signal = AbortSignal.any([prompt.controller.signal, connectionSignal]);
    signal.throwIfAborted();
    if (++prompt.requests > 128) throw new Error("Artifact request budget exceeded");
    // Reject invalid ranges before file I/O or a billable image observation.
    readTextPage("", request.line ?? undefined, request.limit ?? undefined);
    const session = this.options.sessionId();
    if (!/^[A-Za-z0-9_-]+$/.test(session) || request.sessionId !== session) throw new Error("Invalid artifact session");
    const target = request.path;
    if (!path.isAbsolute(target) || target.includes("\0") || target.split(path.sep).some(part => part === ".." || part === ".")) throw new Error("Invalid artifact path");
    const root = path.resolve(this.options.home, "antigravity-acp", "brain", session);
    const stepsRoot = path.join(root, ".system_generated", "steps");
    const mcpRoot = path.join(root, "mcp", "pi-agy-bridge_pi");

    const isStepArtifact = inside(stepsRoot, target);
    const isMcpTarget = target.endsWith(".json") && inside(mcpRoot, target);

    if (!isStepArtifact && !isMcpTarget) throw new Error("Unauthorized artifact path");
    if (path.resolve(target) !== target) throw new Error("Noncanonical artifact path");

    let artifact = prompt.artifacts.get(target);
    if (!artifact) {
      const artifactCount = [...prompt.artifacts.keys()].filter(name => inside(stepsRoot, name)).length;
      if (isStepArtifact && artifactCount >= 8) throw new Error("Artifact file budget exceeded");
      // Reserve a slot before any filesystem or observer await; failures consume it.
      artifact = this.load(root, target, isMcpTarget, signal);
      prompt.artifacts.set(target, artifact);
    }
    const source = await artifact;
    signal.throwIfAborted();
    if (this.options.sessionId() !== session) throw new Error("Artifact session changed");
    const response = source.kind === "snapshot"
      ? readTextPage(source.text, request.line ?? undefined, request.limit ?? undefined)
      : (await this.withFile(root, target, signal, source.identity, (fd, stat) =>
        readTextPageChunks(readChunks(fd, stat.size, signal), request.line ?? undefined, request.limit ?? undefined))).value;
    signal.throwIfAborted();
    if (this.options.sessionId() !== session) throw new Error("Artifact session changed");
    debugLog("acp-read", "Client read completed", {
      sessionId: session, path: target, line: request.line ?? 1,
      responseBytes: Buffer.byteLength(response.content),
    });
    return response;
  }

  private async withFile<T>(root: string, target: string, signal: AbortSignal, expected: FileIdentity | undefined,
    read: (fd: FileHandle, stat: Stats) => Promise<T>): Promise<{ identity: FileIdentity; value: T }> {
    const checked = async <T>(work: Promise<T>): Promise<T> => {
      const result = await work;
      signal.throwIfAborted();
      return result;
    };
    const ancestors = expected?.ancestors ?? [];
    if (!expected) {
      let directory = path.dirname(target);
      while (true) {
        const stat = await checked(lstat(directory));
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Redirected artifact ancestor");
        ancestors.push({ name: directory, stat });
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    const verify = async () => {
      for (const ancestor of ancestors) {
        const current = await checked(lstat(ancestor.name));
        // Sibling artifact creation is expected; only directory identity matters.
        if (!current.isDirectory() || current.dev !== ancestor.stat.dev || current.ino !== ancestor.stat.ino) {
          throw new Error("Artifact ancestor changed");
        }
      }
      if (!same(initial, await checked(lstat(target)))) throw new Error("Artifact changed");
    };
    if (await checked(realpath(root)) !== root || await checked(realpath(target)) !== target) throw new Error("Redirected artifact path");
    const initial = await checked(lstat(target));
    if (!initial.isFile() || initial.nlink !== 1) throw new Error("Artifact must be a regular file with a single link");
    if (expected && !same(expected.stat, initial)) throw new Error("Artifact changed since first read");

    // Do not cancellation-wrap open: its eventual descriptor must always be closed.
    const fd = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      signal.throwIfAborted();
      if (!same(initial, await checked(fd.stat()))) throw new Error("Artifact changed on open");
      await verify();
      const value = await read(fd, initial);
      signal.throwIfAborted();
      if (!same(initial, await checked(fd.stat()))) throw new Error("Artifact changed during read");
      await verify();
      return { identity: { stat: initial, ancestors }, value };
    } finally {
      await fd.close();
    }
  }

  private async load(root: string, target: string, isMcpTarget: boolean, signal: AbortSignal): Promise<Artifact> {
    const { identity, value } = await this.withFile(root, target, signal, undefined, async (fd, stat) => {
      const header = await readBytes(fd, Math.min(stat.size, 12), signal);
      const mimeType = isMcpTarget ? undefined : mime(header);
      return isMcpTarget || mimeType
        ? { bytes: await readBytes(fd, stat.size, signal), mimeType }
        : undefined;
    });
    signal.throwIfAborted();
    if (!value) return { kind: "text", identity };

    const { bytes, mimeType } = value;
    if (mimeType && !isMcpTarget) {
      // The observer owns its deadline and settles only after process cleanup.
      debugLog("acp-read", "Image observer started", { path: target, mimeType, bytes: bytes.length });
      const description = await this.options.observeImage({ data: bytes.toString("base64"), mimeType }, signal);
      signal.throwIfAborted();
      debugLog("acp-read", "Image observer completed", { path: target, responseBytes: Buffer.byteLength(description) });
      return { kind: "snapshot", text: `Image observation (derived):\n${description}` };
    }
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("Binary artifact denied");
    if (isMcpTarget) {
      const schema: unknown = JSON.parse(text);
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("Schema must be a JSON object");
    }
    return { kind: "snapshot", text };
  }
}
