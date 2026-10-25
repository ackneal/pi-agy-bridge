export const MAX_TEXT_PAGE_LINES = 256;
export const MAX_TEXT_PAGE_BYTES = 24 * 1024;

const instructions = "text is verbatim source data; other fields are metadata. Lines use a 1-based line offset. Continue with ACP line=nextLine and limit (1..256). Concatenate decoded text fields to reconstruct the source. LF terminates a line; a final LF adds no extra line. endLine is inclusive, or null for no data. nextLine is null at EOF.";

export function readTextPage(text: string, line = 1, limit = MAX_TEXT_PAGE_LINES): { content: string } {
  if (!Number.isInteger(line) || line < 1 || line > 0xffffffff) {
    throw new RangeError("line must be an integer in 1..4294967295 (1-based)");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 0xffffffff) {
    throw new RangeError("limit must be an integer in 1..4294967295");
  }

  let totalLines = 0;
  let pageStart = text.length;
  for (let offset = 0; offset < text.length;) {
    if (totalLines === line - 1) pageStart = offset;
    totalLines++;
    const newline = text.indexOf("\n", offset);
    offset = newline === -1 ? text.length : newline + 1;
  }
  const response = (source: string, count: number): { content: string } => {
    const endLine = count === 0 ? null : line + count - 1;
    const remainingLines = Math.max(0, totalLines - (endLine ?? line - 1));
    return { content: JSON.stringify({
      text: source,
      startLine: line,
      endLine,
      nextLine: remainingLines === 0 ? null : line + count,
      eof: remainingLines === 0,
      totalLines,
      remainingLines,
      instructions,
    }) };
  };

  let page = response("", 0);
  let offset = pageStart;
  for (let index = line - 1; index < Math.min(totalLines, line - 1 + Math.min(limit, MAX_TEXT_PAGE_LINES)); index++) {
    const newline = text.indexOf("\n", offset);
    const end = newline === -1 ? text.length : newline + 1;
    const candidateSource = text.slice(pageStart, end);
    const candidate = response(candidateSource, index - line + 2);
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_TEXT_PAGE_BYTES) {
      if (index === line - 1) {
        throw new RangeError(`Source line ${line} cannot fit in the ${MAX_TEXT_PAGE_BYTES}-byte serialized response budget; no source was returned or skipped`);
      }
      break;
    }
    offset = end;
    page = candidate;
  }
  return page;
}
