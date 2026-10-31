import { createWriteStream } from "node:fs";
import { chmod, mkdir, lstat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";

function openArchive(file: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, strictFileNames: true }, (error, zip) =>
      error ? reject(error) : resolve(zip),
    );
  });
}

function nextEntry(zip: ZipFile): Promise<Entry | null> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: Entry) => { cleanup(); resolve(entry); };
    const onEnd = () => { cleanup(); resolve(null); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      zip.removeListener("entry", onEntry);
      zip.removeListener("end", onEnd);
      zip.removeListener("error", onError);
    };
    zip.once("entry", onEntry);
    zip.once("end", onEnd);
    zip.once("error", onError);
    zip.readEntry();
  });
}

function entryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream));
  });
}

function safePath(root: string, name: string): string {
  if (!name || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new Error(`Unsafe archive path: ${name}`);
  }
  const segments = name.replace(/\/$/, "").split("/");
  if (segments.some((part) => part === ".." || part === "." || part === "" || part.includes("\0"))) {
    throw new Error(`Unsafe archive path: ${name}`);
  }
  const target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`Unsafe archive path: ${name}`);
  return target;
}

export async function extractArchive(archivePath: string, destination: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const root = path.resolve(destination);
  await mkdir(root, { recursive: true });
  const zip = await openArchive(archivePath);
  const seen = new Set<string>();
  const directories: Array<{ file: string; mode: number }> = [];
  const abort = () => zip.close();
  signal?.addEventListener("abort", abort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("Archive extraction aborted");
      const entry = await nextEntry(zip);
      if (!entry) break;
      const name = entry.fileName;
      const target = safePath(root, name);
      const directory = name.endsWith("/");
      const normalized = directory ? name.slice(0, -1) : name;
      if (!normalized || seen.has(normalized)) throw new Error(`Duplicate archive entry: ${name}`);
      seen.add(normalized);
      for (let ancestor = path.dirname(target); ancestor !== root && ancestor.startsWith(root + path.sep); ancestor = path.dirname(ancestor)) {
        const stat = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (stat && !stat.isDirectory()) throw new Error(`Conflicting archive entry: ${name}`);
      }
      const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
      const type = unixMode & 0o170000;
      if (type === 0o120000 || (type !== 0 && type !== (directory ? 0o040000 : 0o100000))) {
        throw new Error(`Unsupported archive entry type: ${name}`);
      }
      const mode = unixMode ? unixMode & 0o777 : directory ? 0o755 : 0o644;
      if (directory) {
        await mkdir(target, { recursive: true, mode: 0o700 });
        directories.push({ file: target, mode });
      } else {
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const stream = await entryStream(zip, entry);
        await pipeline(stream, createWriteStream(target, { mode, flags: "wx" }), { signal });
        await chmod(target, mode);
      }
    }
    directories.sort((a, b) => b.file.split(path.sep).length - a.file.split(path.sep).length);
    for (const directory of directories) {
      signal?.throwIfAborted();
      await chmod(directory.file, directory.mode);
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    zip.close();
  }
}
