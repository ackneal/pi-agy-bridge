import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ReadTextFileResponse } from "@agentclientprotocol/sdk";
import { MAX_TEXT_PAGE_BYTES, MAX_TEXT_PAGE_LINES, readTextPage, readTextPageChunks } from "./text-page.ts";

// Only tests parse the presentation hint; ACP callbacks receive line, not start_line.
function parsePage(content: string) {
  const match = /\n\n\[Showing lines (\d+)-(\d+) \(128 KiB \/ 2000-line cap\)\. Use start_line=(\d+) to continue \(1-based line offset\)\.\]$/.exec(content);
  return { text: match ? content.slice(0, match.index) : content,
    endLine: match ? Number(match[2]) : null,
    nextLine: match ? Number(match[3]) : null };
}

function serializedSize(result: { content: string }): number {
  return JSON.stringify(result).replace(/[\u007f-\uffff]/g, unit =>
    `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).length;
}

const cases = [
  { name: "empty", text: "", line: 1, limit: 256, expected: "", end: null, next: null },
  { name: "beyond EOF", text: "a\n", line: 8, limit: 1, expected: "", end: null, next: null },
  { name: "CRLF and smaller limit", text: "a\r\nb\r\n", line: 1, limit: 1, expected: "a\r\n", end: 1, next: 2 },
  { name: "no final newline", text: "a\nb", line: 2, limit: 1, expected: "b", end: 2, next: null },
  { name: "blank final line", text: "\n\n", line: 1, limit: 256, expected: "\n\n", end: 2, next: null },
  { name: "Unicode and escaping", text: '\u0000\t"\\😀\ud800\r\n終', line: 1, limit: 256, expected: '\u0000\t"\\😀\ud800\r\n終', end: 2, next: null },
];
for (const row of cases) {
  test(`readTextPage: ${row.name}`, () => {
    const result: ReadTextFileResponse = readTextPage(row.text, row.line, row.limit);
    const page = parsePage(result.content);
    assert.equal(page.text, row.expected);
    assert.equal(page.nextLine, row.next);
    if (row.next === null) assert.equal(result.content, row.expected);
    else assert.equal(result.content, `${row.expected}\n\n[Showing lines ${row.line}-${row.end} (128 KiB / 2000-line cap). Use start_line=${row.next} to continue (1-based line offset).]`);
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
  const page = parsePage(readTextPage("x\n".repeat(2500), 1, 3000).content);
  assert.equal(page.text, "x\n".repeat(MAX_TEXT_PAGE_LINES));
  assert.equal(page.endLine, MAX_TEXT_PAGE_LINES);
  assert.equal(page.nextLine, MAX_TEXT_PAGE_LINES + 1);
});

for (const row of [
  { name: "default line bound", text: "x\n".repeat(2500), firstCount: MAX_TEXT_PAGE_LINES },
  { name: "ASCII serialized escaping budget", text: ('"\\\u0000😀'.repeat(300) + '\r\n').repeat(500), firstCount: undefined },
  { name: "mixed multipage", text: ("α😀\r\n\nend\n").repeat(2500) + "tail", firstCount: MAX_TEXT_PAGE_LINES },
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

async function* byteChunks(bytes: Uint8Array, size = 7): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

for (const row of [
  ...cases.filter(row => !row.text.includes("\0")),
  { name: "BOM retained", text: "\ufefffirst\r\n\ufeffsecond", line: 1, limit: 1 },
  { name: "split UTF8", text: "α😀終\r\nlast", line: 1, limit: 1 },
  { name: "exact EOF budget", text: "x".repeat(MAX_TEXT_PAGE_BYTES - 14), line: 1, limit: 2000 },
  { name: "EOF fits without footer", text: "x".repeat(MAX_TEXT_PAGE_BYTES - 17) + "\nb", line: 1, limit: 2000 },
  { name: "exact EOF at line limit", text: "x".repeat(MAX_TEXT_PAGE_BYTES - 16) + "\n", line: 1, limit: 1 },
  { name: "escaped exact EOF", text: '"'.repeat((MAX_TEXT_PAGE_BYTES - 14) / 2), line: 1, limit: 1 },
  { name: "skip huge line", text: "x".repeat(MAX_TEXT_PAGE_BYTES * 3) + "\nlast", line: 2, limit: 1 },
  { name: "line bound", text: "x\n".repeat(2500), line: 1, limit: 3000 },
]) {
  test(`chunk pagination: ${row.name}`, async () => {
    const result: ReadTextFileResponse = await readTextPageChunks(byteChunks(new TextEncoder().encode(row.text)), row.line, row.limit);
    assert.deepEqual(result, readTextPage(row.text, row.line, row.limit));
    assert.ok(serializedSize(result) <= MAX_TEXT_PAGE_BYTES);
    if (row.name.includes("exact EOF")) assert.equal(serializedSize(result), MAX_TEXT_PAGE_BYTES);
  });
}

for (const row of [
  { name: "ASCII", text: "x".repeat(MAX_TEXT_PAGE_BYTES - 13) },
  { name: "escaping", text: '"'.repeat((MAX_TEXT_PAGE_BYTES - 14) / 2) + "x" },
  { name: "footer required", text: "x".repeat(MAX_TEXT_PAGE_BYTES - 20) + "\ntail", limit: 1 },
]) {
  test(`chunk pagination rejects unfit first line: ${row.name}`, async () => {
    await assert.rejects(readTextPageChunks(byteChunks(new TextEncoder().encode(row.text)), 1, row.limit), /Source line 1 cannot fit.*no source was returned or skipped/);
    assert.throws(() => readTextPage(row.text, 1, row.limit), /Source line 1 cannot fit/);
  });
}

for (const row of [
  { name: "invalid UTF8", bytes: new Uint8Array([0xc3, 0x28]), error: /encoded data/ },
  { name: "incomplete UTF8 at EOF", bytes: new Uint8Array([0xf0, 0x9f]), error: /encoded data/ },
  { name: "NUL", bytes: new Uint8Array([97, 0, 10]), error: /must not contain NUL/ },
  { name: "NUL in skipped line", bytes: new Uint8Array([0, 10, 97]), error: /must not contain NUL/, line: 2 },
]) {
  test(`chunk text rejects ${row.name}`, async () => {
    await assert.rejects(readTextPageChunks(byteChunks(row.bytes, 1), row.line), row.error);
  });
}

for (const field of ["line", "limit"] as const) {
  for (const value of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, 0x100000000, null, "1", {}, [], true]) {
    test(`chunks reject ${field}=${String(value)} before consumption`, async () => {
      let consumed = false;
      async function* chunks() {
        consumed = true;
        yield new Uint8Array();
      }
      await assert.rejects(readTextPageChunks(chunks(), field === "line" ? value as number : 1, field === "limit" ? value as number : 1), new RegExp(`^RangeError: ${field} must be an integer`));
      assert.equal(consumed, false);
    });
  }
}

for (const row of [
  { name: "huge first line", prefix: "", fill: "x".repeat(4096), limit: 2000, rejects: true, expected: undefined },
  { name: "huge next line", prefix: "ok\n", fill: "x".repeat(4096), limit: 2000, rejects: false, expected: "ok\n" },
  { name: "line count", prefix: "", fill: "x\n".repeat(2048), limit: 2000, rejects: false, expected: "x\n".repeat(2000) },
  { name: "requested count", prefix: "", fill: "x\n".repeat(2048), limit: 1, rejects: false, expected: "x\n" },
]) {
  test(`bounded consumption and cleanup: ${row.name}`, async () => {
    let pulled = 0;
    let closed = false;
    async function* chunks() {
      try {
        if (row.prefix) yield new TextEncoder().encode(row.prefix);
        for (let index = 0; index < 1_000_000; index++) {
          pulled++;
          yield new TextEncoder().encode(row.fill);
        }
      } finally {
        closed = true;
      }
    }
    if (row.rejects) await assert.rejects(readTextPageChunks(chunks(), 1, row.limit), /Source line 1 cannot fit/);
    else {
      const result = await readTextPageChunks(chunks(), 1, row.limit);
      assert.equal(parsePage(result.content).text, row.expected);
      assert.ok(serializedSize(result) <= MAX_TEXT_PAGE_BYTES);
    }
    assert.ok(pulled <= 33, `consumed ${pulled} chunks`);
    assert.equal(closed, true);
  });
}

test("chunk pages reconstruct exact UTF8 bytes", async () => {
  const text = "\ufeff" + ('α😀\r\n\n"\\\tend\n').repeat(2500) + "終";
  const bytes = new TextEncoder().encode(text);
  const parts: string[] = [];
  let line: number | null = 1;
  do {
    const result = await readTextPageChunks(byteChunks(bytes, 127), line);
    const page = parsePage(result.content);
    assert.ok(serializedSize(result) <= MAX_TEXT_PAGE_BYTES);
    assert.ok(page.text.match(/[^\n]*\n|[^\n]+$/g)!.length <= MAX_TEXT_PAGE_LINES);
    parts.push(page.text);
    line = page.nextLine;
  } while (line !== null);
  assert.ok(parts.length > 1);
  assert.deepEqual(new TextEncoder().encode(parts.join("")), bytes);
});
