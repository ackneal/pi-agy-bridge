import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { readTextPage } from "./text-page.ts";
import { debugLog } from "../../shared/debug.ts";

interface Options {
  home: string;
  sessionId: () => string;
  allowedToolNames?: ReadonlySet<string>;
  observeImage: (image: { data: string; mimeType: string }, signal: AbortSignal) => Promise<string>;
}
interface Prompt {
  controller: AbortController;
  snapshots: Map<string, Promise<string>>;
  requests: number;
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
    this.prompt = { controller: new AbortController(), snapshots: new Map(), requests: 0 };
  }

  async endPrompt(): Promise<void> {
    const prompt = this.prompt;
    if (!prompt) return;
    prompt.controller.abort(new Error("Artifact prompt ended"));
    await Promise.allSettled(prompt.snapshots.values());
    if (this.prompt === prompt) this.prompt = undefined;
  }

  async read(request: acp.ReadTextFileRequest, connectionSignal: AbortSignal): Promise<acp.ReadTextFileResponse> {
    const prompt = this.prompt;
    if (!prompt) throw new Error("No active artifact prompt");
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

    let snapshot = prompt.snapshots.get(target);
    if (!snapshot) {
      const artifactCount = [...prompt.snapshots.keys()].filter(name => inside(stepsRoot, name)).length;
      if (isStepArtifact && artifactCount >= 8) throw new Error("Artifact file budget exceeded");
      // Reserve a slot before any filesystem or observer await; failures consume it.
      snapshot = this.load(root, target, isMcpTarget, prompt, signal);
      prompt.snapshots.set(target, snapshot);
    }
    const text = await snapshot;
    signal.throwIfAborted();
    if (this.options.sessionId() !== session) throw new Error("Artifact session changed");
    const response = readTextPage(text, request.line ?? undefined, request.limit ?? undefined);
    debugLog("acp-read", "Client read completed", {
      sessionId: session, path: target, line: request.line ?? 1,
      responseBytes: Buffer.byteLength(response.content),
    });
    return response;
  }

  private async load(root: string, target: string, isMcpTarget: boolean, prompt: Prompt, signal: AbortSignal): Promise<string> {
    const checked = async <T>(work: Promise<T>): Promise<T> => {
      const result = await work;
      signal.throwIfAborted();
      return result;
    };
    const ancestors: Array<{ name: string; stat: Stats }> = [];
    let directory = path.dirname(target);
    while (true) {
      const stat = await checked(lstat(directory));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Redirected artifact ancestor");
      ancestors.push({ name: directory, stat });
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
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

    // Do not cancellation-wrap open: its eventual descriptor must always be closed.
    const fd = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      signal.throwIfAborted();
      if (!same(initial, await checked(fd.stat()))) throw new Error("Artifact changed on open");
      await verify();
      bytes = Buffer.alloc(initial.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await checked(fd.read(bytes, offset, bytes.length - offset, offset));
        if (!result.bytesRead) throw new Error("Artifact shortened during read");
        offset += result.bytesRead;
      }
      if (!same(initial, await checked(fd.stat()))) throw new Error("Artifact changed during read");
      await verify();
    } finally {
      await fd.close();
    }
    signal.throwIfAborted();
    const mimeType = mime(bytes);
    if (mimeType && !isMcpTarget) {
      // The observer owns its deadline and settles only after process cleanup.
      debugLog("acp-read", "Image observer started", { path: target, mimeType, bytes: bytes.length });
      const description = await this.options.observeImage({ data: bytes.toString("base64"), mimeType }, signal);
      signal.throwIfAborted();
      debugLog("acp-read", "Image observer completed", { path: target, responseBytes: Buffer.byteLength(description) });
      return `Image observation (derived):\n${description}`;
    }
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("Binary artifact denied");
    if (isMcpTarget) {
      const schema: unknown = JSON.parse(text);
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("Schema must be a JSON object");
    }
    return text;
  }
}
