import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import type { ReadTextFileRequest, SessionNotification } from "@agentclientprotocol/sdk";
import { ProbeReader } from "./acp-probe-reader.ts";
import { readTextPage } from "../src/extension/drivers/acp/text-page.ts";

// Test-owned synthetic safety fixtures, never evidence of live ACP offloading.
async function fixture() {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "probe-reader-")));
  const sessionId = "test-session_1";
  const root = path.join(home, "antigravity-acp", "brain", sessionId);
  const steps = path.join(root, ".system_generated", "steps");
  const metadata = path.join(root, "mcp", "pi-agy-bridge_pi");
  await mkdir(steps, { recursive: true });
  await mkdir(metadata, { recursive: true });
  const target = path.join(steps, "result.txt");
  await writeFile(target, "first\nsecond\nTAIL_RECEIPT=test_tail\n");
  const reader = new ProbeReader({ home, sessionId });
  reader.active = true;
  const request: ReadTextFileRequest = { sessionId, path: target };
  return { home, root, steps, metadata, target, sessionId, reader, request };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const signal = (): AbortSignal => new AbortController().signal;

const invalidCases: { name: string; arrange: (f: Fixture) => Promise<void> | void; reason: string }[] = [
  { name: "inactive", arrange: f => { f.reader.active = false; }, reason: "inactive" },
  { name: "RPC path must not be a file URI", arrange: f => { f.request.path = pathToFileURL(f.target).href; }, reason: "invalid path" },
  { name: "other session", arrange: f => { f.request.sessionId = "other"; }, reason: "invalid session" },
  { name: "unsafe configured session", arrange: f => { f.reader = new ProbeReader({ home: f.home, sessionId: "../bad" }); f.reader.active = true; f.request.sessionId = "../bad"; }, reason: "invalid session" },
  ...["line", "limit"].flatMap(field => [0, -1, 1.5, NaN, Infinity, 0x100000000].map(value => ({
    name: `${field} ${value} rejected before I/O`,
    arrange: (f: Fixture) => { f.request.path = path.join(f.steps, "missing"); Object.assign(f.request, { [field]: value }); },
    reason: "invalid range",
  }))),
  { name: "relative path", arrange: f => { f.request.path = "result.txt"; }, reason: "invalid path" },
  { name: "noncanonical path", arrange: f => { f.request.path = `${f.steps}/../steps/result.txt`; }, reason: "invalid path" },
  { name: "NUL path", arrange: f => { f.request.path += "\0"; }, reason: "invalid path" },
  ...["project.txt", ".credentials", "antigravity-acp/brain/other/.system_generated/steps/result.txt", "antigravity-acp/brain/test-session_1/.system_generated/steps-evil/result.txt"].map(relative => ({
    name: `outside allowlist ${relative}`,
    arrange: async (f: Fixture) => { f.request.path = path.join(f.home, relative); await mkdir(path.dirname(f.request.path), { recursive: true }); await writeFile(f.request.path, "SECRET_DO_NOT_REPORT"); },
    reason: "unauthorized path",
  })),
  { name: "unknown metadata", arrange: async f => { f.request.path = path.join(f.metadata, "credentials.json"); await writeFile(f.request.path, "SECRET_DO_NOT_REPORT"); }, reason: "unauthorized path" },
  { name: "directory", arrange: f => { f.request.path = f.steps; }, reason: "unauthorized path" },
  { name: "nested directory", arrange: async f => { f.request.path = path.join(f.steps, "directory"); await mkdir(f.request.path); }, reason: "not a single-link regular file" },
  { name: "symlink file", arrange: async f => { const other = path.join(f.home, "secret"); await writeFile(other, "SECRET_DO_NOT_REPORT"); await rm(f.target); await symlink(other, f.target); }, reason: "redirected path" },
  { name: "symlink ancestor", arrange: async f => { const other = path.join(f.home, "outside"); await mkdir(other); await writeFile(path.join(other, "result.txt"), "SECRET_DO_NOT_REPORT"); await rm(f.steps, { recursive: true }); await symlink(other, f.steps); }, reason: "redirected ancestor" },
  { name: "hardlink", arrange: async f => { await link(f.target, path.join(f.home, "second-link")); }, reason: "not a single-link regular file" },
  { name: "over 8MiB", arrange: async f => { await truncate(f.target, 8 * 1024 * 1024 + 1); }, reason: "file budget exceeded" },
  { name: "invalid UTF8", arrange: async f => { await writeFile(f.target, Buffer.from([0xff, 0xfe])); }, reason: "not UTF8 text" },
  { name: "NUL binary", arrange: async f => { await writeFile(f.target, "secret\0text"); }, reason: "not text" },
  { name: "control binary", arrange: async f => { await writeFile(f.target, Buffer.from([1, 2, 3])); }, reason: "not text" },
];
for (const row of invalidCases) test(`safety: ${row.name}`, async () => {
  const f = await fixture();
  try {
    await row.arrange(f);
    await assert.rejects(f.reader.read(f.request, signal()), { message: row.reason });
    assert.equal(f.reader.reads.at(-1)?.error, row.reason);
    assert.equal(f.reader.reads.at(-1)?.responseBytes, undefined);
    assert.deepEqual(f.reader.artifacts, []);
    assert.ok(!JSON.stringify(f.reader.reads).includes("SECRET_DO_NOT_REPORT"));
  } finally { f.reader.active = false; await rm(f.home, { recursive: true, force: true }); }
});

for (const row of [
  { name: "first page", line: 1, limit: 1, nextLine: 2, tails: [] },
  { name: "tail page", line: 3, limit: 1, nextLine: undefined, tails: ["test_tail"] },
  { name: "past EOF", line: 9, limit: 1, nextLine: undefined, tails: [] },
  { name: "default page", line: undefined, limit: undefined, nextLine: undefined, tails: ["test_tail"] },
]) test(`pagination: ${row.name}`, async () => {
  const f = await fixture();
  try {
    const source = "first\nsecond\nTAIL_RECEIPT=test_tail\n";
    const request = { ...f.request, ...(row.line === undefined ? {} : { line: row.line }), ...(row.limit === undefined ? {} : { limit: row.limit }) };
    const result = await f.reader.read(request, signal());
    assert.deepEqual(result, readTextPage(source, row.line, row.limit));
    assert.deepEqual(f.reader.reads[0], {
      request: { path: f.target, line: row.line ?? 1, limit: row.limit ?? 256, kind: "artifact" },
      responseBytes: Buffer.byteLength(result.content),
      responseSha256: createHash("sha256").update(result.content).digest("hex"),
      tailReceipts: row.tails,
      ...(row.nextLine === undefined ? {} : { nextLine: row.nextLine }),
    });
    assert.deepEqual(f.reader.artifacts, [{ path: f.target, bytes: Buffer.byteLength(source), sha256: createHash("sha256").update(source).digest("hex"), tailReceipts: ["test_tail"] }]);
    assert.deepEqual(f.reader.references, []); // A real callback can be the first reference.
  } finally { f.reader.active = false; await rm(f.home, { recursive: true, force: true }); }
});

for (const name of ["instructions.md", "mcp__pi__offload_probe.json"]) test(`exact metadata: ${name}`, async () => {
  const f = await fixture();
  try {
    const target = path.join(f.metadata, name);
    await writeFile(target, "metadata before execution");
    assert.equal((await f.reader.read({ ...f.request, path: target }, signal())).content, "metadata before execution");
    assert.equal(f.reader.reads[0]?.request?.kind, "metadata");
    assert.deepEqual(f.reader.artifacts, []);
  } finally { f.reader.active = false; await rm(f.home, { recursive: true, force: true }); }
});

for (const row of [
  { name: "same epoch immutable", reset: false, expected: "first\nsecond\nTAIL_RECEIPT=test_tail\n", count: 1 },
  { name: "new epoch new snapshot", reset: true, expected: "changed\n", count: 2 },
]) test(`snapshot: ${row.name}`, async () => {
  const f = await fixture();
  try {
    await f.reader.read(f.request, signal());
    await writeFile(f.target, "changed\n");
    if (row.reset) { f.reader.active = false; f.reader.active = true; }
    assert.equal((await f.reader.read(f.request, signal())).content, row.expected);
    assert.equal(f.reader.artifacts.length, row.count);
  } finally { f.reader.active = false; await rm(f.home, { recursive: true, force: true }); }
});

for (const row of [
  { name: "current notification string values", session: "current", expected: true, keysOnly: false },
  { name: "file URL notification", session: "current", expected: true, keysOnly: false, url: true },
  { name: "other notification ignored", session: "other", expected: false, keysOnly: false },
  { name: "object keys ignored", session: "current", expected: false, keysOnly: true },
]) test(`observe: ${row.name}`, async () => {
  const f = await fixture();
  try {
    const reference = row.url ? pathToFileURL(f.target).href : f.target;
    const notification: SessionNotification = {
      sessionId: row.session === "current" ? f.sessionId : "other",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: row.keysOnly ? "no reference" : `Read \`${reference}\` and ${reference}` }, _meta: { [f.target]: 123, nested: { text: row.keysOnly ? "none" : reference }, metadata: path.join(f.metadata, "instructions.md"), external: "/etc/passwd" } },
    };
    f.reader.observe(notification);
    assert.deepEqual(f.reader.references, row.expected ? [f.target] : []);
    assert.deepEqual(f.reader.reads, []);
  } finally { f.reader.active = false; await rm(f.home, { recursive: true, force: true }); }
});

for (const row of [
  { name: "already aborted", during: false },
  { name: "abort during async I/O", during: true },
]) test(`abort: ${row.name}`, async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    if (!row.during) controller.abort(new Error("SECRET_DO_NOT_REPORT"));
    const pending = f.reader.read(f.request, controller.signal);
    if (row.during) controller.abort(new Error("SECRET_DO_NOT_REPORT"));
    await assert.rejects(pending, { message: "aborted" });
    assert.equal(f.reader.reads[0]?.error, "aborted");
    assert.deepEqual(f.reader.artifacts, []);
  } finally { f.reader.active = false; await rm(f.home, { recursive: true, force: true }); }
});

for (const budget of ["requests", "artifacts", "bytes"] as const) test(`budget: ${budget}`, async () => {
  const f = await fixture();
  try {
    if (budget === "requests") {
      for (let i = 0; i < 128; i++) await f.reader.read(f.request, signal());
      await assert.rejects(f.reader.read(f.request, signal()), { message: "request budget exceeded" });
    } else {
      const count = budget === "artifacts" ? 8 : 2;
      for (let i = 0; i < count; i++) {
        const target = path.join(f.steps, `${i}.txt`);
        await writeFile(target, budget === "bytes" ? "x\n".repeat(4 * 1024 * 1024) : "small\n");
        await f.reader.read({ ...f.request, path: target }, signal());
      }
      await assert.rejects(f.reader.read(f.request, signal()), { message: budget === "bytes" ? "source budget exceeded" : "artifact budget exceeded" });
    }
  } finally { f.reader.active = false; await rm(f.home, { recursive: true, force: true }); }
});

for (const row of [
  { name: "line cap", source: "line\n".repeat(700) + "TAIL_RECEIPT=last\n", expectedNext: 257 },
  { name: "serialized UTF8 byte cap", source: "😀".repeat(100) + "\n", repeat: 600, expectedNext: undefined },
]) test(`production page bounds: ${row.name}`, async () => {
  const f = await fixture();
  try {
    const source = row.source.repeat(row.repeat ?? 1);
    await writeFile(f.target, source);
    const response = await f.reader.read(f.request, signal());
    assert.deepEqual(response, readTextPage(source));
    assert.ok(f.reader.reads[0]?.nextLine !== undefined);
    if (row.expectedNext !== undefined) assert.equal(f.reader.reads[0]?.nextLine, row.expectedNext);
    assert.deepEqual(f.reader.reads[0]?.tailReceipts, []);
  } finally { f.reader.active = false; await rm(f.home, { recursive: true, force: true }); }
});

test("unpageable source fails with a static error and no source leakage", async () => {
  const f = await fixture();
  try {
    await writeFile(f.target, "SECRET_DO_NOT_REPORT".repeat(2000));
    await assert.rejects(f.reader.read(f.request, signal()), { message: "read failed" });
    assert.equal(f.reader.reads[0]?.error, "read failed");
    assert.equal(f.reader.reads[0]?.responseBytes, undefined);
    assert.ok(!JSON.stringify({ reads: f.reader.reads, artifacts: f.reader.artifacts }).includes("SECRET_DO_NOT_REPORT"));
  } finally { f.reader.active = false; await rm(f.home, { recursive: true, force: true }); }
});
