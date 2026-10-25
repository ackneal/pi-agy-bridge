import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ReadTextFileResponse } from "@agentclientprotocol/sdk";
import { MAX_TEXT_PAGE_BYTES, MAX_TEXT_PAGE_LINES, readTextPage } from "./text-page.ts";

// Only tests parse the presentation hint; ACP callbacks receive line, not start_line.
function parsePage(content: string) {
  const match = /\n\n\[Showing lines (\d+)-(\d+) of (\d+)\. Use start_line=(\d+) to continue \(1-based line offset\)\.\]$/.exec(content);
  return { text: match ? content.slice(0, match.index) : content,
    endLine: match ? Number(match[2]) : null,
    nextLine: match ? Number(match[4]) : null };
}

function serializedSize(result: { content: string }): number {
  return JSON.stringify(result).replace(/[\u007f-\uffff]/g, unit =>
    `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).length;
}

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
    const page = parsePage(result.content);
    assert.equal(page.text, row.expected);
    assert.equal(page.nextLine, row.next);
    if (row.next === null) assert.equal(result.content, row.expected);
    else assert.equal(result.content, `${row.expected}\n\n[Showing lines ${row.line}-${row.end} of ${row.total}. Use start_line=${row.next} to continue (1-based line offset).]`);
    assert.ok(serializedSize(result) <= MAX_TEXT_PAGE_BYTES);
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
  const page = parsePage(readTextPage("x\n".repeat(700), 1, 1000).content);
  assert.equal(page.text, "x\n".repeat(MAX_TEXT_PAGE_LINES));
  assert.equal(page.endLine, MAX_TEXT_PAGE_LINES);
  assert.equal(page.nextLine, MAX_TEXT_PAGE_LINES + 1);
});

for (const row of [
  { name: "default line bound", text: "x\n".repeat(700), firstCount: MAX_TEXT_PAGE_LINES },
  { name: "ASCII serialized escaping budget", text: ('"\\\u0000😀'.repeat(300) + '\r\n').repeat(20), firstCount: undefined },
  { name: "mixed multipage", text: ("α😀\r\n\nend\n").repeat(900) + "tail", firstCount: MAX_TEXT_PAGE_LINES },
]) {
  test(`lossless reconstruction: ${row.name}`, () => {
    let line: number | null = 1;
    const parts: string[] = [];
    do {
      const result = readTextPage(row.text, line);
      const page = parsePage(result.content);
      assert.ok(serializedSize(result) <= MAX_TEXT_PAGE_BYTES);
      assert.ok(page.text.match(/[^\n]*\n|[^\n]+$/g)!.length <= MAX_TEXT_PAGE_LINES);
      if (parts.length === 0 && row.firstCount !== undefined) assert.equal(page.endLine, row.firstCount);
      if (parts.length === 0 && row.firstCount === undefined) assert.ok(page.endLine !== null && page.endLine < 20);
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

for (const text of ["x".repeat(MAX_TEXT_PAGE_BYTES), '"'.repeat(MAX_TEXT_PAGE_BYTES / 2), "😀".repeat(MAX_TEXT_PAGE_BYTES / 4)]) {
  test(`overlong line (${text.length} code units) is never skipped`, () => {
    const first = parsePage(readTextPage(`ok\n${text}\nafter`).content);
    assert.equal(first.text, "ok\n");
    assert.equal(first.nextLine, 2);
    assert.throws(() => readTextPage(`ok\n${text}\nafter`, 2), /Source line 2 cannot fit.*no source was returned or skipped/);
  });
}

for (const row of [
  { name: "exact EOF budget", text: "x".repeat(MAX_TEXT_PAGE_BYTES - 14), limit: 256 },
  { name: "EOF fits without intermediate footer", text: "x".repeat(MAX_TEXT_PAGE_BYTES - 17) + "\nb", limit: 256 },
]) {
  test(row.name, () => {
    const result = readTextPage(row.text, 1, row.limit);
    assert.equal(result.content, row.text);
    assert.ok(serializedSize(result) <= MAX_TEXT_PAGE_BYTES);
  });
}

test("footer participates in budget even when source alone fits", () => {
  const text = "x".repeat(MAX_TEXT_PAGE_BYTES - 20) + "\ntail";
  assert.throws(() => readTextPage(text, 1, 1), /Source line 1 cannot fit/);
});
