import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile, rm, symlink, link, truncate, open, rename, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcpArtifactReader } from "./artifact-reader.ts";

async function fixture() {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "acp-reader-")));
  const root = path.join(home, "antigravity-acp/brain/session");
  const steps = path.join(root, ".system_generated/steps");
  const metadata = path.join(root, "mcp/pi-agy-bridge_pi");
  await mkdir(steps, { recursive: true });
  await mkdir(metadata, { recursive: true });
  const observed: Array<{ data: string; mimeType: string }> = [];
  const reader = new AcpArtifactReader({ home, sessionId: () => "session", allowedToolNames: new Set(["read"]), observeImage: async image => { observed.push(image); return "visible text"; } });
  reader.beginPrompt();
  const read = (file: string, line?: number, limit?: number, signal = new AbortController().signal) => reader.read({ sessionId: "session", path: file, line: line ?? null, limit: limit ?? null }, signal);
  return { home, root, steps, metadata, reader, read, observed, cleanup: async () => { await reader.endPrompt(); await rm(home, { recursive: true, force: true }); } };
}

test("immutable text pagination and prompt reset", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.steps, "result");
    await writeFile(file, "one\ntwo\nthree\n");
    assert.equal(JSON.parse((await f.read(file, 1, 1)).content).nextLine, 2);
    await writeFile(file, "replacement");
    assert.equal(JSON.parse((await f.read(file, 2, 2)).content).text, "two\nthree\n");
    await f.reader.endPrompt();
    f.reader.beginPrompt();
    assert.equal(JSON.parse((await f.read(file)).content).text, "replacement");
  } finally { await f.cleanup(); }
});

test("UTF-8 tool text preserves CRLF, Unicode and ANSI sequences", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.steps, "output");
    const text = "\u001b[31m紅色😀\u001b[0m\r\n";
    await writeFile(file, text);
    assert.equal(JSON.parse((await f.read(file)).content).text, text);
  } finally { await f.cleanup(); }
});

for (const row of [
  { name: "relative", file: "relative", error: /Invalid artifact path/ },
  { name: "traversal", file: "/tmp/../secret", error: /Invalid artifact path/ },
  { name: "NUL", file: "/tmp/\0", error: /Invalid artifact path/ },
  { name: "cross session", suffix: "../other/.system_generated/steps/a", error: /Unauthorized/ },
  { name: "unknown tool", suffix: "mcp/pi-agy-bridge_pi/bash.json", error: /Unauthorized/ },
  { name: "unknown server", suffix: "mcp/other/read.json", error: /Unauthorized/ },
  { name: "arbitrary file", suffix: "secret", error: /Unauthorized/ },
]) {
  test(`rejects ${row.name}`, async () => {
    const f = await fixture();
    try { await assert.rejects(f.read(row.file ?? path.join(f.root, row.suffix!)), row.error); }
    finally { await f.cleanup(); }
  });
}

test("session callback identity and invalid segments", async () => {
  for (const session of ["../session", "", "other"]) {
    const reader = new AcpArtifactReader({ home: "/tmp", sessionId: () => session, allowedToolNames: new Set(), observeImage: async () => "" });
    reader.beginPrompt();
    await assert.rejects(reader.read({ sessionId: "session", path: "/tmp/file" }, new AbortController().signal), /Invalid artifact session/);
    await reader.endPrompt();
  }
});

for (const kind of ["symlink", "parent symlink", "hardlink", "directory", "oversize", "binary", "schema array"] as const) {
  test(`rejects ${kind}`, async () => {
    const f = await fixture();
    try {
      let file = path.join(f.steps, "result");
      await writeFile(file, "source");
      if (kind === "symlink") { const dest = file + "-link"; await symlink(file, dest); file = dest; }
      if (kind === "parent symlink") { await symlink(f.steps, path.join(f.steps, "redirect")); file = path.join(f.steps, "redirect/result"); }
      if (kind === "hardlink") await link(file, file + "-link");
      if (kind === "directory") file = f.steps + "/directory", await mkdir(file);
      if (kind === "oversize") await truncate(file, 8 * 1024 * 1024 + 1);
      if (kind === "binary") await writeFile(file, Buffer.from([255, 0]));
      if (kind === "schema array") { file = path.join(f.metadata, "read.json"); await writeFile(file, "[]"); }
      await assert.rejects(f.read(file), kind === "oversize" ? /size exceeded/ : kind === "schema array" ? /JSON object/ : kind === "binary" ? /encoded data|encoding/i : /Redirected|regular/);
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
      assert.match(JSON.parse((await f.read(file)).content).text, /Derived image description/);
      await f.read(file);
      assert.deepEqual(f.observed, [{ data: bytes.toString("base64"), mimeType }]);
    } finally { await f.cleanup(); }
  });
}

test("metadata stays text and validates only JSON object", async () => {
  const f = await fixture();
  try {
    for (const [name, text] of [["read.json", '{"anything":true}'], ["instructions.md", "instructions"]]) {
      const file = path.join(f.metadata, name!);
      await writeFile(file, text!);
      assert.equal(JSON.parse((await f.read(file)).content).text, text);
    }
    assert.equal(f.observed.length, 0);
  } finally { await f.cleanup(); }
});

test("registered tool schemas do not consume artifact file slots", async () => {
  const f = await fixture();
  const tools = Array.from({ length: 10 }, (_, index) => `tool${index}`);
  const reader = new AcpArtifactReader({
    home: f.home, sessionId: () => "session", allowedToolNames: new Set(tools),
    observeImage: async () => { throw new Error("Metadata must not invoke the observer"); },
  });
  reader.beginPrompt();
  try {
    for (const tool of tools) {
      const file = path.join(f.metadata, `${tool}.json`);
      await writeFile(file, "{}");
      assert.equal(JSON.parse((await reader.read({ sessionId: "session", path: file }, new AbortController().signal)).content).text, "{}");
    }
    const artifact = path.join(f.steps, "result");
    await writeFile(artifact, "tool output");
    assert.equal(JSON.parse((await reader.read({ sessionId: "session", path: artifact }, new AbortController().signal)).content).text, "tool output");
  } finally {
    await reader.endPrompt();
    await f.cleanup();
  }
});

test("request and concurrent file reservations are bounded", async () => {
  const f = await fixture();
  try {
    const files = await Promise.all(Array.from({ length: 9 }, async (_, i) => { const file = path.join(f.steps, String(i)); await writeFile(file, "x"); return file; }));
    const results = await Promise.allSettled(files.map(file => f.read(file)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 8);
    for (let i = 9; i < 128; i++) await f.read(files[0]!);
    await assert.rejects(f.read(files[0]!), /request budget/);
  } finally { await f.cleanup(); }
});

test("aggregate byte budget reserves before concurrent reads", async () => {
  const f = await fixture();
  try {
    const files = await Promise.all([0, 1, 2].map(async i => { const file = path.join(f.steps, String(i)); await writeFile(file, ""); await truncate(file, 8 * 1024 * 1024); return file; }));
    const results = await Promise.allSettled(files.map(file => f.read(file)));
    assert.ok(results.some(result => result.status === "rejected" && /source byte budget/.test(String(result.reason))));
  } finally { await f.cleanup(); }
});

test("a new prompt cannot take ownership before the old observer cleanup settles", async () => {
  const f = await fixture();
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const observing = new Promise<void>(resolve => { started = resolve; });
  let cleaned = false;
  const reader = new AcpArtifactReader({
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
    assert.equal(JSON.parse(page.content).text, "new snapshot\n");
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
      const reader = new AcpArtifactReader({ home: f.home, sessionId: () => "session", allowedToolNames: new Set(), observeImage: async (_, signal) => {
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
      if (change === "sibling creation") assert.equal(JSON.parse((await f.read(file)).content).text, "original\n");
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
      ["long", "x".repeat(30_000), /cannot fit/],
      ["schema", "{", /JSON/],
      ["control", "a\0b", /Binary artifact/],
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
    assert.equal(JSON.parse((await f.read(missing)).content).text, "\ufefforiginal\n");
    await assert.rejects(f.read(missing, 0), /line must/);
    assert.equal(JSON.parse((await f.read(missing, 1, 1000)).content).eof, true);
    await assert.rejects(f.read(missing, 1, 0), /limit must/);
  } finally { await f.cleanup(); }
});
