export const MAX_TEXT_PAGE_LINES = 256;
export const MAX_TEXT_PAGE_BYTES = 24 * 1024;

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
  // start_line on model-facing client_view_file maps to ACP callback line;
  // Pi's read uses offset instead. Keep the hint in the model-facing vocabulary.
  const response = (source: string, count: number): { content: string } => ({
    content: line + count - 1 < totalLines
      ? `${source}\n\n[Showing lines ${line}-${line + count - 1} of ${totalLines}. Use start_line=${line + count} to continue (1-based line offset).]`
      : source,
  });
  // This is a conservative response-payload budget, not a universal AGY wire limit.
  // Persisted truncation measured ASCII characters: escape each non-ASCII UTF-16
  // unit (including both halves of surrogate pairs) after JSON serialization.
  const fits = (page: { content: string }): boolean =>
    JSON.stringify(page).replace(/[\u007f-\uffff]/g, unit =>
      `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).length <= MAX_TEXT_PAGE_BYTES;

  if (pageStart === text.length) return { content: "" };

  const countLimit = Math.min(limit, MAX_TEXT_PAGE_LINES);
  // At EOF the footer disappears; test that candidate before rejecting a
  // smaller page whose continuation hint might itself push it over budget.
  if (totalLines - line + 1 <= countLimit) {
    const complete = { content: text.slice(pageStart) };
    if (fits(complete)) return complete;
  }

  let page = { content: "" };
  let offset = pageStart;
  for (let index = line - 1; index < Math.min(totalLines, line - 1 + countLimit); index++) {
    const newline = text.indexOf("\n", offset);
    const end = newline === -1 ? text.length : newline + 1;
    const candidate = response(text.slice(pageStart, end), index - line + 2);
    if (!fits(candidate)) {
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
