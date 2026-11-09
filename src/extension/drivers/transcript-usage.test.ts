import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import { readLastCallUsage } from "./transcript-usage.ts";

const model = {
  step_index: 5,
  source: "MODEL",
  type: "PLANNER_RESPONSE",
  status: "DONE",
  created_at: "2026-11-09T14:31:54Z",
  input_tokens: 8461,
  cache_read_tokens: 0,
  output_tokens: 734,
};
const first = { ...model, step_index: 2, input_tokens: 6000, output_tokens: 160 };
const jsonl = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const expected = (input = 8461, output = 734, cacheRead = 0, cacheWrite = 0, step = 5) => ({
  step,
  timestamp: Date.parse(model.created_at),
  usage: {
    input, output, cacheRead, cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  } satisfies Usage,
});

type Case = {
  name: string;
  content?: string;
  result?: ReturnType<typeof expected>;
  driver?: "cli" | "acp";
  sessionId?: string;
  file?: "directory" | "symlink";
  append?: string;
  nextResult?: ReturnType<typeof expected>;
  otherHome?: boolean;
};

const cases: Case[] = [
  { name: "two calls total 15355 but last call is 9195", content: jsonl(first, model), result: expected() },
  { name: "ACP uses its own transcript", driver: "acp", content: jsonl(model), result: expected() },
  {
    name: "input is uncached and cache read is added for last total 64228",
    content: jsonl(first, { ...model, input_tokens: 10000, cache_read_tokens: 53000, output_tokens: 1228 }),
    result: expected(10000, 1228, 53000),
  },
  {
    name: "cache writes are added and thoughts are not added again",
    content: jsonl({ ...model, cache_write_tokens: 12, thoughts_tokens: 100, total_tokens: 999999 }),
    result: expected(8461, 734, 0, 12),
  },
  {
    name: "zero counts are valid",
    content: jsonl({ ...model, step_index: 0, input_tokens: 0, output_tokens: 0 }),
    result: expected(0, 0, 0, 0, 0),
  },
  {
    name: "tool and user rows do not replace model usage",
    content: jsonl(model, { source: "TOOL", text: "placeholder" }, { source: "USER", text: "placeholder" }),
    result: expected(),
  },
  { name: "complete last JSON without newline", content: JSON.stringify(model), result: expected() },
  { name: "CRLF and empty lines", content: `\r\n${JSON.stringify(model)}\r\n\r\n`, result: expected() },
  { name: "missing transcript" },
  { name: "empty transcript", content: "" },
  { name: "only unrelated rows", content: jsonl({ source: "USER" }, { source: "TOOL" }) },
  { name: "malformed JSON", content: "placeholder\n" },
  { name: "partial latest JSON blocks older usage", content: jsonl(model) + '{"source":"MODEL"' },
  { name: "partial unrelated JSON also blocks older usage", content: jsonl(model) + '{"source":"TOOL"' },
  { name: "invalid JSON with newline blocks older usage", content: jsonl(model) + "{\n" },
  { name: "unsupported primitive", content: jsonl(model, 1) },
  { name: "unsupported array", content: jsonl(model, []) },
  { name: "unsupported null", content: jsonl(model, null) },
  { name: "unsupported schema does not guess response totals", content: jsonl({ response: { total_tokens: 9195 } }) },
  { name: "directory is not a regular file", file: "directory" },
  { name: "final symlink is rejected", file: "symlink", content: jsonl(model) },
  { name: "explicit home is not cached", content: jsonl(model), otherHome: true },
  {
    name: "repeated reads and appended new step are fresh",
    content: jsonl(model), result: expected(),
    append: jsonl({ ...model, step_index: 6, created_at: "2026-11-09T14:31:55Z", input_tokens: 100 }),
    nextResult: { ...expected(100, 734, 0, 0, 6), timestamp: Date.parse("2026-11-09T14:31:55Z") },
  },
  {
    name: "appended incomplete step suppresses previous usage",
    content: jsonl(model), result: expected(), append: '{"step_index":6',
  },
  {
    name: "over-bound old row is skipped before complete last row",
    content: jsonl({ source: "USER", text: "x".repeat(1024 * 1024) }, model), result: expected(),
  },
  {
    name: "over-bound final model row cannot expose older usage",
    content: jsonl(model, { ...model, step_index: 6, text: "x".repeat(1024 * 1024) }),
  },
  {
    name: "over-bound final user row cannot expose older usage",
    content: jsonl(model, { source: "USER", text: "x".repeat(1024 * 1024) }),
  },
  {
    name: "over-bound incomplete final row cannot expose older usage",
    content: jsonl(model) + '{"text":"' + "x".repeat(1024 * 1024),
  },
  ...["", ".", "..", "../session", "a/b", "a\\b", "/session", "a\0b", "a%2fb"].map((sessionId) => ({
    name: `unsafe session id ${JSON.stringify(sessionId)}`, sessionId, content: jsonl(model),
  })),
  ...[
    { status: "RUNNING" },
    { status: "ERROR" },
    { type: "OTHER" },
    { input_tokens: undefined },
    { input_tokens: "8461" },
    { input_tokens: -1 },
    { input_tokens: 1.5 },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { input_tokens: Number.MAX_SAFE_INTEGER },
    { output_tokens: undefined },
    { output_tokens: null },
    { cache_read_tokens: undefined },
    { cache_read_tokens: -1 },
    { cache_write_tokens: null },
    { cache_write_tokens: "12" },
    { cache_write_tokens: -1 },
    { step_index: undefined },
    { step_index: -1 },
    { step_index: 1.5 },
    { created_at: undefined },
    { created_at: 123 },
    { created_at: "invalid" },
    { created_at: "2026-99-99T14:31:54Z" },
  ].map((patch) => ({
    name: `latest invalid model blocks older usage: ${Object.keys(patch)[0]}=${String(Object.values(patch)[0])}`,
    content: jsonl(model, { ...model, step_index: 6, ...patch }),
  })),
];

for (const entry of cases) {
  test(`readLastCallUsage: ${entry.name}`, async (t) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agy-transcript-usage-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const driver = entry.driver ?? "cli";
    const sessionId = entry.sessionId ?? "session_1-2";
    // Plant a readable transcript at the unsafe path too, so a missing file cannot hide missing validation.
    const fixtureSession = sessionId.includes("\0") ? "session_1-2" : sessionId;
    const filename = path.join(home, `antigravity-${driver}`, "brain", fixtureSession, ".system_generated", "logs", "transcript.jsonl");
    await mkdir(path.dirname(filename), { recursive: true });
    if (entry.file === "directory") {
      await mkdir(filename);
    } else if (entry.file === "symlink") {
      const target = path.join(home, "target.jsonl");
      await writeFile(target, entry.content!);
      await symlink(target, filename);
    } else if (entry.content !== undefined) {
      await writeFile(filename, entry.content);
    }

    const result = await readLastCallUsage(home, driver, sessionId);

    assert.deepEqual(result, entry.otherHome ? expected() : entry.result);
    if (entry.otherHome) {
      assert.equal(await readLastCallUsage(path.join(home, "other-home"), driver, sessionId), undefined);
    }
    if (entry.append !== undefined) {
      assert.deepEqual(await readLastCallUsage(home, driver, sessionId), entry.result);
      await appendFile(filename, entry.append);
      assert.deepEqual(await readLastCallUsage(home, driver, sessionId), entry.nextResult);
    }
  });
}
