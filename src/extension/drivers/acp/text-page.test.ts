import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ReadTextFileResponse } from "@agentclientprotocol/sdk";
import { MAX_TEXT_PAGE_BYTES, MAX_TEXT_PAGE_LINES, readTextPage } from "./text-page.ts";

const cases = [
  { name: "empty", text: "", line: 1, limit: 256, expected: "", end: null, next: null, total: 0 },
  { name: "beyond EOF", text: "a\n", line: 8, limit: 1, expected: "", end: null, next: null, total: 1 },
  { name: "CRLF and smaller limit", text: "a\r\nb\r\n", line: 1, limit: 1, expected: "a\r\n", end: 1, next: 2, total: 2 },
  { name: "no final newline", text: "a\nb", line: 2, limit: 1, expected: "b", end: 2, next: null, total: 2 },
  { name: "blank final line", text: "\n\n", line: 1, limit: 256, expected: "\n\n", end: 2, next: null, total: 2 },
  { name: "Unicode and escaping", text: '\u0000\t"\\😀\ud800\r\n終', line: 1, limit: 256, expected: '\u0000\t"\\😀\ud800\r\n終', end: 2, next: null, total: 2 },
];
for (const row of cases) {
  test(`readTextPage: ${row.name}`, () => {
    const result: ReadTextFileResponse = readTextPage(row.text, row.line, row.limit);
    const page = JSON.parse(result.content);
    assert.equal(page.text, row.expected);
    assert.equal(page.startLine, row.line);
    assert.equal(page.endLine, row.end);
    assert.equal(page.nextLine, row.next);
    assert.equal(page.totalLines, row.total);
    assert.equal(page.eof, row.next === null);
    assert.equal(page.remainingLines, row.next === null ? 0 : row.total - row.next + 1);
    assert.match(page.instructions, /1-based.*ACP line=nextLine and limit/);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_TEXT_PAGE_BYTES);
  });
}

for (const field of ["line", "limit"] as const) {
  for (const value of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, 0x100000000, null, "1", {}, [], true]) {
    test(`reject ${field}=${String(value)}`, () => {
      const invalid = value as number;
      assert.throws(() => readTextPage("", field === "line" ? invalid : 1, field === "limit" ? invalid : 1), new RegExp(`^RangeError: ${field} must be an integer`));
    });
  }
}
test("oversized requested limit returns a bounded page with continuation", () => {
  const page = JSON.parse(readTextPage("x\n".repeat(700), 1, 1000).content);
  assert.equal(page.text, "x\n".repeat(MAX_TEXT_PAGE_LINES));
  assert.equal(page.endLine, MAX_TEXT_PAGE_LINES);
  assert.equal(page.nextLine, MAX_TEXT_PAGE_LINES + 1);
  assert.equal(page.eof, false);
});

for (const row of [
  { name: "default line bound", text: "x\n".repeat(700), firstCount: MAX_TEXT_PAGE_LINES },
  { name: "double JSON escaping budget", text: ('"\\\u0000😀'.repeat(300) + '\r\n').repeat(20), firstCount: undefined },
  { name: "mixed multipage", text: ("α😀\r\n\nend\n").repeat(900) + "tail", firstCount: MAX_TEXT_PAGE_LINES },
]) {
  test(`lossless reconstruction: ${row.name}`, () => {
    let line: number | null = 1;
    const parts: string[] = [];
    do {
      const result = readTextPage(row.text, line);
      const page = JSON.parse(result.content);
      assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_TEXT_PAGE_BYTES);
      assert.ok(page.endLine - page.startLine + 1 <= MAX_TEXT_PAGE_LINES);
      if (parts.length === 0 && row.firstCount !== undefined) assert.equal(page.endLine, row.firstCount);
      if (parts.length === 0 && row.firstCount === undefined) assert.ok(page.endLine < 20);
      assert.ok(page.text.length > 0);
      parts.push(page.text);
      line = page.nextLine;
    } while (line !== null);
    assert.ok(parts.length > 1);
    assert.equal(parts.join(""), row.text);
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    assert.equal(hash(parts.join("")), hash(row.text));
  });
}

for (const text of ["x".repeat(MAX_TEXT_PAGE_BYTES), '"'.repeat(MAX_TEXT_PAGE_BYTES / 3), "😀".repeat(MAX_TEXT_PAGE_BYTES / 4)]) {
  test(`overlong line (${text.length} code units) is never skipped`, () => {
    const first = JSON.parse(readTextPage(`ok\n${text}\nafter`).content);
    assert.equal(first.text, "ok\n");
    assert.equal(first.nextLine, 2);
    assert.throws(() => readTextPage(`ok\n${text}\nafter`, 2), /Source line 2 cannot fit.*no source was returned or skipped/);
  });
}
