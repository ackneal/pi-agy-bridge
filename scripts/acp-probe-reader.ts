import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReadTextFileRequest, ReadTextFileResponse, SessionNotification } from "@agentclientprotocol/sdk";
import { MAX_TEXT_PAGE_LINES, readTextPage } from "../src/extension/drivers/acp/text-page.ts";

type Kind = "artifact" | "metadata";
type SafeRequest = { path: string; line: number; limit: number; kind: Kind };
export interface ProbeReadFact {
  request?: SafeRequest;
  responseBytes?: number;
  responseSha256?: string;
  nextLine?: number;
  tailReceipts?: string[];
  error?: string;
}
export interface ProbeArtifactFact { path: string; bytes: number; sha256: string; tailReceipts: string[] }
interface Prompt {
  controller: AbortController;
  snapshots: Map<string, Promise<string>>;
  requests: number;
  artifacts: number;
  bytes: number;
}
class Denied extends Error {}
const deny = (reason: string): never => { throw new Denied(reason); };
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const receipts = (text: string): string[] => [...new Set([...text.matchAll(/TAIL_RECEIPT=([A-Za-z0-9_-]+)/g)].map(match => match[1]!))];
const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.nlink === b.nlink && a.ctimeMs === b.ctimeMs && a.mtimeMs === b.mtimeMs;

/** Trusted local owner only: ancestor checks/O_NOFOLLOW are not a sandbox against
 * hostile same-UID directory replacement. Main correlates recovery with the real
 * MCP audit and fails on any recorded read error. No source text is reported.
 * Toggle active only around each real pending prompt; false aborts that epoch.
 */
export class ProbeReader {
  readonly references: string[] = [];
  readonly reads: ProbeReadFact[] = [];
  readonly artifacts: ProbeArtifactFact[] = [];
  private readonly home: string;
  private readonly sessionId: string;
  private prompt: Prompt | undefined;

  constructor({ home, sessionId }: { home: string; sessionId: string }) {
    this.home = home;
    this.sessionId = sessionId;
  }

  get active(): boolean { return this.prompt !== undefined; }
  set active(value: boolean) {
    if (value === this.active) return;
    this.prompt?.controller.abort();
    this.prompt = value ? { controller: new AbortController(), snapshots: new Map(), requests: 0, artifacts: 0, bytes: 0 } : undefined;
  }

  private kind(target: string): Kind {
    if (!/^[A-Za-z0-9_-]+$/.test(this.sessionId)) return deny("invalid session");
    if (!path.isAbsolute(this.home) || path.resolve(this.home) !== this.home) return deny("invalid home");
    if (typeof target !== "string" || /[\x00-\x1f\x7f]/.test(target) || !path.isAbsolute(target) || path.resolve(target) !== target) return deny("invalid path");
    const root = path.join(this.home, "antigravity-acp", "brain", this.sessionId);
    const relative = path.relative(root, target);
    if (relative.startsWith(`.system_generated${path.sep}steps${path.sep}`) && relative.split(path.sep).length > 2) return "artifact";
    if (["instructions.md", "mcp__pi__offload_probe.json"].some(name => relative === path.join("mcp", "pi-agy-bridge_pi", name))) return "metadata";
    return deny("unauthorized path");
  }

  observe(notification: SessionNotification): void {
    if (notification.sessionId !== this.sessionId) return;
    const visit = (value: unknown): void => {
      if (typeof value === "string") {
        for (const match of value.matchAll(/file:\/\/[^\s"'<>`\[\]{}(),;]+|\/[^\s"'<>`\[\]{}(),;]+/g)) {
          try {
            const candidate = match[0].startsWith("file://") ? fileURLToPath(match[0]) : match[0];
            if (this.kind(candidate) === "artifact" && !this.references.includes(candidate)) this.references.push(candidate);
          } catch { /* Notification text is not an authorization grant. */ }
        }
      } else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    visit(notification.update);
  }

  async read(request: ReadTextFileRequest, signal: AbortSignal): Promise<ReadTextFileResponse> {
    const fact: ProbeReadFact = {};
    this.reads.push(fact);
    try {
      const prompt = this.prompt;
      if (!prompt) return deny("inactive");
      if (++prompt.requests > 128) return deny("request budget exceeded");
      if (request.sessionId !== this.sessionId) return deny("invalid session");
      try { readTextPage("", request.line ?? undefined, request.limit ?? undefined); }
      catch { return deny("invalid range"); }
      const kind = this.kind(request.path);
      fact.request = { path: request.path, line: request.line ?? 1, limit: request.limit ?? MAX_TEXT_PAGE_LINES, kind };
      const combined = AbortSignal.any([signal, prompt.controller.signal]);
      combined.throwIfAborted();
      let snapshot = prompt.snapshots.get(request.path);
      if (!snapshot) {
        if (kind === "artifact" && ++prompt.artifacts > 8) return deny("artifact budget exceeded");
        snapshot = this.load(request.path, kind, prompt, combined);
        prompt.snapshots.set(request.path, snapshot);
      }
      const text = await snapshot;
      combined.throwIfAborted();
      const response = readTextPage(text, request.line ?? undefined, request.limit ?? undefined);
      fact.responseBytes = Buffer.byteLength(response.content);
      fact.responseSha256 = hash(response.content);
      fact.tailReceipts = receipts(response.content);
      const footer = /\n\n\[Showing lines \d+-\d+ of \d+\. Use start_line=(\d+) to continue \(1-based line offset\)\.\]$/.exec(response.content);
      if (footer) fact.nextLine = Number(footer[1]);
      return response;
    } catch (error) {
      fact.error = error instanceof Denied ? error.message : signal.aborted || !this.active ? "aborted" : "read failed";
      throw new Error(fact.error);
    }
  }

  private async load(target: string, kind: Kind, prompt: Prompt, signal: AbortSignal): Promise<string> {
    const checked = async <T>(work: Promise<T>): Promise<T> => {
      const result = await work;
      signal.throwIfAborted();
      return result;
    };
    const ancestors: { name: string; stat: Stats }[] = [];
    for (let name = path.dirname(target);;) {
      const stat = await checked(lstat(name));
      if (!stat.isDirectory() || stat.isSymbolicLink()) return deny("redirected ancestor");
      ancestors.push({ name, stat });
      const parent = path.dirname(name);
      if (parent === name) break;
      name = parent;
    }
    if (await checked(realpath(target)) !== target) return deny("redirected path");
    const initial = await checked(lstat(target));
    if (!initial.isFile() || initial.nlink !== 1) return deny("not a single-link regular file");
    if (initial.size > 8 * 1024 * 1024) return deny("file budget exceeded");
    if (prompt.bytes + initial.size > 16 * 1024 * 1024) return deny("source budget exceeded");
    prompt.bytes += initial.size;

    const verify = async (): Promise<void> => {
      for (const ancestor of ancestors) {
        const current = await checked(lstat(ancestor.name));
        if (!current.isDirectory() || current.dev !== ancestor.stat.dev || current.ino !== ancestor.stat.ino) return deny("ancestor changed");
      }
      if (!same(initial, await checked(lstat(target)))) return deny("file changed");
    };
    // Open cannot be cancellation-wrapped: even a late descriptor needs closing.
    const fd = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      signal.throwIfAborted();
      if (!same(initial, await checked(fd.stat()))) return deny("file changed");
      await verify();
      bytes = Buffer.alloc(initial.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await checked(fd.read(bytes, offset, bytes.length - offset, offset));
        if (!result.bytesRead) return deny("file shortened");
        offset += result.bytesRead;
      }
      if (!same(initial, await checked(fd.stat()))) return deny("file changed");
      await verify();
    } finally { await fd.close(); }
    signal.throwIfAborted();
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { return deny("not UTF8 text"); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return deny("not text");
    if (kind === "artifact") this.artifacts.push({ path: target, bytes: bytes.length, sha256: hash(bytes), tailReceipts: receipts(text) });
    return text;
  }
}
