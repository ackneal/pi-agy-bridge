import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile, rm, symlink, link, truncate, open, rename, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArtifactReader } from "./artifact-reader.ts";

async function fixture() {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "acp-reader-")));
  const root = path.join(home, "antigravity-acp/brain/session");
  const steps = path.join(root, ".system_generated/steps");
  const metadata = path.join(root, "mcp/pi-agy-bridge_pi");
  await mkdir(steps, { recursive: true });
  await mkdir(metadata, { recursive: true });
  const observed: Array<{ data: string; mimeType: string }> = [];
  const reader = new ArtifactReader({ home, sessionId: () => "session", allowedToolNames: new Set(["read"]), observeImage: async image => { observed.push(image); return "visible text"; } });
  reader.beginPrompt();
  const read = (file: string, line?: number, limit?: number, signal = new AbortController().signal) => reader.read({ sessionId: "session", path: file, line: line ?? null, limit: limit ?? null }, signal);
  return { home, root, steps, metadata, reader, read, observed, cleanup: async () => { await reader.endPrompt(); await rm(home, { recursive: true, force: true }); } };
}

test("text changes are rejected until prompt reset", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.steps, "result");
    await writeFile(file, "one\ntwo\nthree\n");
    assert.match((await f.read(file, 1, 1)).content, /^one\n[\s\S]*start_line=2/);
    await writeFile(file, "replacement");
    await assert.rejects(f.read(file, 2, 2), /Artifact changed/);
    await f.reader.endPrompt();
    f.reader.beginPrompt();
    assert.equal((await f.read(file)).content, "replacement");
  } finally { await f.cleanup(); }
});

for (const size of [16 * 1024 * 1024, 1024 * 1024 * 1024]) {
  test(`small page from ${size}-byte artifact uses bounded buffers and reads`, async (t) => {
    const f = await fixture();
    let probe: FileHandle | undefined;
    try {
      const file = path.join(f.steps, "large");
      await writeFile(file, "first\n" + "x\n".repeat(70_000));
      await truncate(file, size);
      probe = await open(file, "r");
      const prototype = Object.getPrototypeOf(probe) as FileHandle;
      const read = prototype.read;
      const alloc = Buffer.alloc;
      let bytesRead = 0;
      let maxAllocation = 0;
      t.mock.method(Buffer, "alloc", (length: number) => {
        maxAllocation = Math.max(maxAllocation, length);
        assert.ok(length <= 128 * 1024, `unexpected ${length}-byte allocation`);
        return alloc(length);
      });
      t.mock.method(prototype, "read", async function (this: FileHandle, buffer: Buffer, offset: number, length: number, position: number) {
        const result = await read.call(this, { buffer, offset, length, position });
        bytesRead += result.bytesRead;
        return result;
      });
      const page = await f.read(file, 1, 1);
      assert.match(page.content, /^first\n[\s\S]*start_line=2/);
      assert.ok(bytesRead <= 128 * 1024 + 12);
      assert.equal(maxAllocation, 128 * 1024);
    } finally {
      await probe?.close();
      t.mock.restoreAll();
      await f.cleanup();
    }
  });
}

for (const text of [
  "a\r\n\n紅色😀\r\n尾",
  "\ufeff" + "α😀\r\n\nend\n".repeat(2100),
]) {
  test(`file pages reconstruct text (${text.length} code units)`, async () => {
    const f = await fixture();
    try {
      const file = path.join(f.steps, "pages");
      await writeFile(file, text);
      let line = 1;
      const parts: string[] = [];
      while (true) {
        const { content } = await f.read(file, line, 1000);
        const footer = /\n\n\[Showing lines [^\]]*Use start_line=(\d+) to continue[^\]]*\]$/.exec(content);
        parts.push(footer ? content.slice(0, footer.index) : content);
        if (!footer) break;
        line = Number(footer[1]);
      }
      assert.equal(parts.join(""), text);
      assert.equal((await f.read(file, 1, 1)).content, (await f.read(file, 1, 1)).content);
    } finally { await f.cleanup(); }
  });
}

for (const change of ["overwrite", "replace"] as const) {
  test(`later page rejects ${change}`, async () => {
    const f = await fixture();
    try {
      const file = path.join(f.steps, "changed");
      await writeFile(file, "first\nsecond\n");
      await f.read(file, 1, 1);
      if (change === "overwrite") await writeFile(file, "other\nsecond\n");
      else {
        await writeFile(file + "-new", "first\nsecond\n");
        await rename(file + "-new", file);
      }
      await assert.rejects(f.read(file, 2, 1), /Artifact changed since first read/);
    } finally { await f.cleanup(); }
  });
}

for (const action of ["modify", "replace", "connection abort", "prompt abort"] as const) {
  test(`page read cleanup after ${action}`, async (t) => {
    const f = await fixture();
    let probe: FileHandle | undefined;
    let ending: Promise<void> | undefined;
    try {
      const file = path.join(f.steps, "result");
      await writeFile(file, "one\ntwo\n".repeat(20_000));
      probe = await open(file, "r");
      const prototype = Object.getPrototypeOf(probe) as FileHandle;
      const read = prototype.read;
      const controller = new AbortController();
      let changed = false;
      const handles = new Set<FileHandle>();
      t.mock.method(prototype, "read", async function (this: FileHandle, buffer: Buffer, offset: number, length: number, position: number) {
        const result = await read.call(this, { buffer, offset, length, position });
        handles.add(this);
        if (buffer.length > 12 && !changed) {
          changed = true;
          if (action === "modify") await writeFile(file, "changed\n");
          else if (action === "replace") {
            await writeFile(file + "-new", "replacement\n");
            await rename(file + "-new", file);
          } else if (action === "connection abort") controller.abort(new Error("connection cancelled"));
          else {
            ending = f.reader.endPrompt();
            assert.throws(() => f.reader.beginPrompt(), /Previous artifact prompt/);
          }
        }
        return result;
      });
      await assert.rejects(f.read(file, 1, 1, controller.signal), /Artifact.*changed|cancelled|prompt ended/);
      await ending;
      assert.equal(changed, true);
      assert.equal(handles.size, 2);
      for (const handle of handles) assert.equal(handle.fd, -1, "inspection and page descriptors close before settlement");
    } finally {
      t.mock.restoreAll();
      await probe?.close();
      await ending;
      await f.cleanup();
    }
  });
}

test("endPrompt waits for a cancelled page descriptor to close", async (t) => {
  const f = await fixture();
  let probe: FileHandle | undefined;
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let closing!: () => void;
  const startedClosing = new Promise<void>(resolve => { closing = resolve; });
  let ending: Promise<void> | undefined;
  let rejection: Promise<void> | undefined;
  try {
    const file = path.join(f.steps, "result");
    await writeFile(file, "one\ntwo\n".repeat(20_000));
    probe = await open(file, "r");
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    const read = prototype.read;
    let cleaned = false;
    t.mock.method(prototype, "read", async function (this: FileHandle, buffer: Buffer, offset: number, length: number, position: number) {
      const result = await read.call(this, { buffer, offset, length, position });
      if (buffer.length > 12) {
        const close = this.close;
        t.mock.method(this, "close", async () => {
          closing();
          await released;
          await close.call(this);
          cleaned = true;
        });
        ending = f.reader.endPrompt();
      }
      return result;
    });
    rejection = assert.rejects(f.read(file, 1, 1), /prompt ended/);
    await startedClosing;
    assert.equal(cleaned, false);
    assert.throws(() => f.reader.beginPrompt(), /Previous artifact prompt/);
    release();
    await ending;
    await rejection;
    assert.equal(cleaned, true);
    f.reader.beginPrompt();
  } finally {
    release();
    await ending;
    await rejection;
    t.mock.restoreAll();
    await probe?.close();
    await f.cleanup();
  }
});

test("UTF-8 tool text preserves CRLF, Unicode and ANSI sequences", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.steps, "output");
    const text = "\u001b[31m紅色😀\u001b[0m\r\n";
    await writeFile(file, text);
    assert.equal((await f.read(file)).content, text);
  } finally { await f.cleanup(); }
});

for (const row of [
  { name: "relative", file: "relative", error: /Invalid artifact path/ },
  { name: "traversal", file: "/tmp/../secret", error: /Invalid artifact path/ },
  { name: "NUL", file: "/tmp/\0", error: /Invalid artifact path/ },
  { name: "cross session", suffix: "../other/.system_generated/steps/a", error: /Unauthorized/ },
  { name: "unknown server", suffix: "mcp/other/read.json", error: /Unauthorized/ },
  { name: "non-json in mcp", suffix: "mcp/pi-agy-bridge_pi/other.txt", error: /Unauthorized/ },
  { name: "arbitrary file", suffix: "secret", error: /Unauthorized/ },
  { name: "session log", suffix: ".system_generated/logs/transcript.jsonl", error: /Unauthorized/ },
]) {
  test(`rejects ${row.name}`, async () => {
    const f = await fixture();
    try { await assert.rejects(f.read(row.file ?? path.join(f.root, row.suffix!)), row.error); }
    finally { await f.cleanup(); }
  });
}

test("session callback identity and invalid segments", async () => {
  for (const session of ["../session", "", "other"]) {
    const reader = new ArtifactReader({ home: "/tmp", sessionId: () => session, allowedToolNames: new Set(), observeImage: async () => "" });
    reader.beginPrompt();
    await assert.rejects(reader.read({ sessionId: "session", path: "/tmp/file" }, new AbortController().signal), /Invalid artifact session/);
    await reader.endPrompt();
  }
});

for (const phase of ["inspection", "page"] as const) {
  test(`session change during ${phase} rejects content and closes descriptors`, async (t) => {
    const f = await fixture();
    let probe: FileHandle | undefined;
    let session = "session";
    const reader = new ArtifactReader({ home: f.home, sessionId: () => session, observeImage: async () => "" });
    reader.beginPrompt();
    try {
      const file = path.join(f.steps, "result");
      await writeFile(file, "one\ntwo\n".repeat(20_000));
      probe = await open(file, "r");
      const prototype = Object.getPrototypeOf(probe) as FileHandle;
      const read = prototype.read;
      const handles = new Set<FileHandle>();
      t.mock.method(prototype, "read", async function (this: FileHandle, buffer: Buffer, offset: number, length: number, position: number) {
        const result = await read.call(this, { buffer, offset, length, position });
        handles.add(this);
        if (phase === "inspection" || buffer.length > 12) session = "other";
        return result;
      });
      await assert.rejects(reader.read({ sessionId: "session", path: file, limit: 1 }, new AbortController().signal), /Artifact session changed/);
      assert.equal(handles.size, phase === "inspection" ? 1 : 2);
      for (const handle of handles) assert.equal(handle.fd, -1);
    } finally {
      t.mock.restoreAll();
      await probe?.close();
      await reader.endPrompt();
      await f.cleanup();
    }
  });
}

for (const kind of ["symlink", "parent symlink", "hardlink", "directory", "binary", "schema array"] as const) {
  test(`rejects ${kind}`, async () => {
    const f = await fixture();
    try {
      let file = path.join(f.steps, "result");
      await writeFile(file, "source");
      if (kind === "symlink") { const dest = file + "-link"; await symlink(file, dest); file = dest; }
      if (kind === "parent symlink") { await symlink(f.steps, path.join(f.steps, "redirect")); file = path.join(f.steps, "redirect/result"); }
      if (kind === "hardlink") await link(file, file + "-link");
      if (kind === "directory") file = f.steps + "/directory", await mkdir(file);
      if (kind === "binary") await writeFile(file, Buffer.from([255, 0]));
      if (kind === "schema array") { file = path.join(f.metadata, "read.json"); await writeFile(file, "[]"); }
      await assert.rejects(f.read(file), kind === "schema array" ? /JSON object/ : kind === "binary" ? /encoded data|encoding/i : /Redirected|regular/);
    } finally { await f.cleanup(); }
  });
}

for (const [mimeType, bytes] of [
  ["image/png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
  ["image/jpeg", Buffer.from([255, 216, 255])],
  ["image/gif", Buffer.from("GIF89a")],
  ["image/webp", Buffer.from("RIFF0000WEBP")],
] as const) {
  test(`observes actual ${mimeType} bytes once`, async () => {
    const f = await fixture();
    try {
      const file = path.join(f.steps, "image.txt");
      await writeFile(file, bytes);
      assert.match((await f.read(file)).content, /^Image observation \(derived\):\nvisible text$/);
      await writeFile(file, "replaced with text");
      assert.match((await f.read(file)).content, /^Image observation \(derived\):\nvisible text$/);
      assert.deepEqual(f.observed, [{ data: bytes.toString("base64"), mimeType }]);
    } finally { await f.cleanup(); }
  });
}

test("metadata stays text and validates only JSON object", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.metadata, "read.json");
    const text = '{"anything":true}';
    await writeFile(file, text);
    assert.equal((await f.read(file)).content, text);
    assert.equal(f.observed.length, 0);
  } finally { await f.cleanup(); }
});

test("registered tool schemas do not consume artifact file slots", async () => {
  const f = await fixture();
  const tools = Array.from({ length: 10 }, (_, index) => `tool${index}`);
  const reader = new ArtifactReader({
    home: f.home, sessionId: () => "session", allowedToolNames: new Set(tools),
    observeImage: async () => { throw new Error("Metadata must not invoke the observer"); },
  });
  reader.beginPrompt();
  try {
    for (const tool of tools) {
      const file = path.join(f.metadata, `${tool}.json`);
      await writeFile(file, "{}");
      assert.equal((await reader.read({ sessionId: "session", path: file }, new AbortController().signal)).content, "{}");
    }
    const artifact = path.join(f.steps, "result");
    await writeFile(artifact, "tool output");
    assert.equal((await reader.read({ sessionId: "session", path: artifact }, new AbortController().signal)).content, "tool output");
  } finally {
    await reader.endPrompt();
    await f.cleanup();
  }
});

test("concurrent file reservations are bounded", async () => {
  const f = await fixture();
  try {
    const files = await Promise.all(Array.from({ length: 9 }, async (_, i) => { const file = path.join(f.steps, String(i)); await writeFile(file, "x"); return file; }));
    const results = await Promise.allSettled(files.map(file => f.read(file)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 8);
    for (let i = 9; i < 128; i++) await f.read(files[0]!);
    await assert.rejects(f.read(files[0]!), /request budget/);
  } finally { await f.cleanup(); }
});

test("a new prompt cannot take ownership before the old observer cleanup settles", async () => {
  const f = await fixture();
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const observing = new Promise<void>(resolve => { started = resolve; });
  let cleaned = false;
  const reader = new ArtifactReader({
    home: f.home, sessionId: () => "session", allowedToolNames: new Set(),
    observeImage: async (_, signal) => {
      started();
      await new Promise<void>(resolve => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        if (signal.aborted) resolve();
      });
      await released;
      cleaned = true;
      return "old image observation";
    },
  });
  reader.beginPrompt();
  const file = path.join(f.steps, "image");
  await writeFile(file, "GIF89a");
  const oldRead = reader.read({ sessionId: "session", path: file }, new AbortController().signal);
  const rejected = assert.rejects(oldRead, /prompt ended/);
  try {
    await observing;
    assert.throws(() => reader.beginPrompt(), /Previous artifact prompt/);
    const ending = reader.endPrompt();
    assert.throws(() => reader.beginPrompt(), /Previous artifact prompt/);
    assert.equal(cleaned, false);
    release();
    await ending;
    await rejected;
    assert.equal(cleaned, true);

    await writeFile(file, "new snapshot\n");
    reader.beginPrompt();
    const page = await reader.read({ sessionId: "session", path: file }, new AbortController().signal);
    assert.equal(page.content, "new snapshot\n");
  } finally {
    release();
    await reader.endPrompt();
    await rejected;
    await f.cleanup();
  }
});

test("cancellation aborts observer and denies new work; errors propagate without retry", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.steps, "image");
    await writeFile(file, "GIF87a");
    for (const mode of ["connection", "prompt", "error"] as const) {
      let started!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      let observedSignal: AbortSignal | undefined;
      let calls = 0;
      let cleaned = false;
      const reader = new ArtifactReader({ home: f.home, sessionId: () => "session", allowedToolNames: new Set(), observeImage: async (_, signal) => {
        calls++;
        observedSignal = signal;
        started();
        if (mode === "error") throw new Error("observer failed");
        try {
          return await new Promise<string>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            if (signal.aborted) reject(signal.reason);
          });
        } finally {
          await Promise.resolve();
          cleaned = true;
        }
      } });
      reader.beginPrompt();
      const controller = new AbortController();
      const work = reader.read({ sessionId: "session", path: file }, controller.signal);
      const rejection = assert.rejects(work, mode === "error" ? /observer failed/ : /ended|cancelled/);
      await ready;
      if (mode === "connection") controller.abort(new Error("cancelled"));
      if (mode === "prompt") void reader.endPrompt();
      await rejection;
      assert.equal(calls, 1);
      if (mode !== "error") {
        assert.equal(observedSignal?.aborted, true);
        assert.equal(cleaned, true);
      }
      await reader.endPrompt();
      await assert.rejects(reader.read({ sessionId: "session", path: file }, new AbortController().signal), /No active/);
    }
  } finally { await f.cleanup(); }
});

for (const change of ["file mutation", "parent replacement", "sibling creation"] as const) {
  test(`read-time change: ${change}`, async (t) => {
    const f = await fixture();
    let probe: FileHandle | undefined;
    try {
      const file = path.join(f.steps, "result");
      await writeFile(file, "original\n");
      probe = await open(file, "r");
      const prototype = Object.getPrototypeOf(probe) as FileHandle;
      const read = prototype.read;
      let changed = false;
      t.mock.method(prototype, "read", async function (this: FileHandle, buffer: Buffer, offset: number, length: number, position: number) {
        const result = await read.call(this, { buffer, offset, length, position });
        if (!changed) {
          changed = true;
          if (change === "file mutation") await writeFile(file, "changed source\n");
          else if (change === "parent replacement") {
            await rename(f.steps, `${f.steps}-old`);
            await mkdir(f.steps);
            await writeFile(file, "replacement\n");
          } else await writeFile(path.join(f.steps, "sibling"), "another artifact");
        }
        return result;
      });
      if (change === "sibling creation") assert.equal((await f.read(file)).content, "original\n");
      else await assert.rejects(f.read(file), /Artifact.*changed/);
      assert.equal(changed, true);
    } finally {
      await probe?.close();
      await f.cleanup();
    }
  });
}

test("invalid image ranges fail before a billable observation", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.steps, "image");
    await writeFile(file, "GIF89a");
    await assert.rejects(f.read(file, 0), /line must/);
    assert.equal(f.observed.length, 0);
    await Promise.all([f.read(file), f.read(file)]);
    assert.equal(f.observed.length, 1);
  } finally { await f.cleanup(); }
});

test("text integrity errors are explicit and failed snapshots do not retry", async () => {
  const f = await fixture();
  try {
    for (const [name, text, error] of [
      ["long", "x".repeat(150_000), /cannot fit/],
      ["schema", "{", /JSON/],
      ["control", "a\0b", /NUL/],
    ] as const) {
      await f.reader.endPrompt();
      f.reader.beginPrompt();
      const file = name === "schema" ? path.join(f.metadata, "read.json") : path.join(f.steps, name);
      await writeFile(file, text);
      await assert.rejects(f.read(file), error);
    }
    await f.reader.endPrompt();
    f.reader.beginPrompt();
    const missing = path.join(f.steps, "missing");
    await assert.rejects(f.read(missing), /ENOENT/);
    await writeFile(missing, "now exists");
    await assert.rejects(f.read(missing), /ENOENT/);
    await f.reader.endPrompt();
    f.reader.beginPrompt();
    await writeFile(missing, "\ufefforiginal\n");
    assert.equal((await f.read(missing)).content, "\ufefforiginal\n");
    await assert.rejects(f.read(missing, 0), /line must/);
    assert.equal((await f.read(missing, 1, 1000)).content, "\ufefforiginal\n");
    await assert.rejects(f.read(missing, 1, 0), /limit must/);
  } finally { await f.cleanup(); }
});
