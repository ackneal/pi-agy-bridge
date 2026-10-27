import { stripVTControlCharacters } from "node:util";

const MAX_NAME_LENGTH = 120;
const MAX_ARGS_LENGTH = 1000;
const UNAVAILABLE_ARGS = "[unserializable arguments]";

function bounded(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function renderArgs(args: unknown): string {
  try {
    // Key-based masking is not comprehensive credential sanitization.
    const serialized = JSON.stringify(args === undefined ? {} : args, (key, value: unknown) =>
      /token|password|secret|authorization|cookie|api[_-]?key/i.test(key) ? "[REDACTED]" : value,
    );
    const rendered = (serialized ?? UNAVAILABLE_ARGS)
      .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    return bounded(rendered, MAX_ARGS_LENGTH);
  } catch {
    return UNAVAILABLE_ARGS;
  }
}

export function formatAcpToolWarning(name: string, args: unknown): string {
  const tool = bounded(stripVTControlCharacters(name)
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ""), MAX_NAME_LENGTH);

  return `Antigravity ACP: unverified tool activity — ${tool} ${renderArgs(args)}`;
}
