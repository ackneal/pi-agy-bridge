export const MAX_TEXT_PAGE_LINES = 2000;
export const MAX_TEXT_PAGE_BYTES = 128 * 1024;

type TextPage = { content: string };

function validateRange(line: number, limit: number): void {
  if (!Number.isInteger(line) || line < 1 || line > 0xffffffff) {
    throw new RangeError("line must be an integer in 1..4294967295 (1-based)");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 0xffffffff) {
    throw new RangeError("limit must be an integer in 1..4294967295");
  }
}

// Count JSON escapes conservatively: each non-ASCII UTF-16 unit costs six
// bytes, including both halves of a surrogate pair. The object costs 14 bytes.
function serializedUnitSize(unit: number): number {
  if (unit >= 0x7f) return 6;
  if (unit === 34 || unit === 92 || [8, 9, 10, 12, 13].includes(unit)) return 2;
  return unit < 32 ? 6 : 1;
}

class TextPaginator {
  private skip: number;
  private readonly countLimit: number;
  private source = "";
  private size = 14;
  private count = 0;
  private partial = false;
  private safeLength = 0;
  private safeCount = 0;

  constructor(private readonly line: number, limit: number) {
    validateRange(line, limit);
    this.skip = line - 1;
    this.countLimit = Math.min(limit, MAX_TEXT_PAGE_LINES);
  }

  private footer(count: number): string {
    // start_line is the model-facing name for the ACP callback's line field.
    return `\n\n[Showing lines ${this.line}-${this.line + count - 1} (128 KiB / 2000-line cap). Use start_line=${this.line + count} to continue (1-based line offset).]`;
  }

  private continuation(): TextPage {
    if (this.safeCount === 0) {
      throw new RangeError(`Source line ${this.line} cannot fit in the ${MAX_TEXT_PAGE_BYTES}-byte serialized response budget; no source was returned or skipped`);
    }
    return { content: this.source.slice(0, this.safeLength) + this.footer(this.safeCount) };
  }

  private completeLine(): void {
    this.count++;
    this.partial = false;
    const footer = this.footer(this.count);
    // Only the two newlines need JSON escaping in this ASCII footer.
    if (this.size + footer.length + 2 <= MAX_TEXT_PAGE_BYTES) {
      this.safeLength = this.source.length;
      this.safeCount = this.count;
    }
  }

  push(text: string): TextPage | undefined {
    let offset = 0;
    while (offset < text.length) {
      if (this.skip > 0) {
        const newline = text.indexOf("\n", offset);
        if (newline === -1) return;
        this.skip--;
        offset = newline + 1;
        continue;
      }
      if (this.count === this.countLimit) return this.continuation();

      const start = offset;
      while (offset < text.length) {
        const unit = text.charCodeAt(offset);
        const cost = serializedUnitSize(unit);
        if (this.size + cost > MAX_TEXT_PAGE_BYTES) return this.continuation();
        this.size += cost;
        offset++;
        this.partial = true;
        if (unit === 10) break;
      }
      this.source += text.slice(start, offset);
      if (text.charCodeAt(offset - 1) === 10) this.completeLine();
    }
  }

  finish(): TextPage {
    if (this.partial) this.completeLine();
    return { content: this.source };
  }
}

export function readTextPage(text: string, line = 1, limit = MAX_TEXT_PAGE_LINES): TextPage {
  const paginator = new TextPaginator(line, limit);
  return paginator.push(text) ?? paginator.finish();
}

export async function readTextPageChunks(
  chunks: AsyncIterable<Uint8Array>, line = 1, limit = MAX_TEXT_PAGE_LINES,
): Promise<TextPage> {
  const paginator = new TextPaginator(line, limit);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for await (const chunk of chunks) {
    const text = decoder.decode(chunk, { stream: true });
    if (text.includes("\0")) throw new TypeError("File text must not contain NUL bytes");
    const page = paginator.push(text);
    if (page) return page;
  }

  const tail = decoder.decode();
  if (tail.includes("\0")) throw new TypeError("File text must not contain NUL bytes");
  return paginator.push(tail) ?? paginator.finish();
}
