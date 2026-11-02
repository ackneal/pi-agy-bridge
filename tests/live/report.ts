import { chmod, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type Status = "PASS" | "FAIL" | "INCONCLUSIVE" | "SKIP";

export interface Result {
  id: string;
  description: string;
  expected: unknown;
  observed: unknown;
  status: Status;
  reason: string;
  category: "setup" | "backend" | "model" | "transport" | "bridge" | "limitation";
  deterministic: boolean;
  environment: Record<string, string>;
  evidence: string;
}

export class ScenarioOutcome extends Error {
  readonly status: "SKIP" | "INCONCLUSIVE";
  constructor(status: "SKIP" | "INCONCLUSIVE", message: string) {
    super(message);
    this.status = status;
  }
}

export class ScenarioFailure extends Error {
  readonly category: Result["category"];
  constructor(category: Result["category"], message: string, cause?: unknown) {
    super(message, { cause });
    this.category = category;
  }
}

const redacted = "[REDACTED]";
const statuses: Status[] = ["PASS", "FAIL", "INCONCLUSIVE", "SKIP"];

export function sanitize(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^/\s@]+@/gi, `$1${redacted}@`)
      .replace(/(\b[a-z][a-z\d+.-]*:\/\/[^\s?#<>"'`]+)\?[^\s<>"'`]*/gi, `$1?${redacted}`)
      .replace(/\bBearer\s+[^\s,"'<>`]+/gi, `Bearer ${redacted}`)
      .replace(/((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|password|client[_-]?secret)["']?\s*[:=]\s*["']?)[^\s,"'&<>]+/gi, `$1${redacted}`)
      .replace(/(\bhttps?:\/\/[^\s#<>"'`]+)#[^\s<>"'`]*/gi, `$1#${redacted}`)
      .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, redacted)
      .replaceAll(homedir(), "[HOME]")
      .replace(/(?:\/(?:Users|home)\/[^/\s"'<>]+|[A-Z]:\\Users\\[^\\\s"'<>]+|~)(?=[/\\]|$)/gi, "[HOME]");
  }

  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      /token|auth|credential|email|account|password|secret|api[_-]?key/i.test(key) ? redacted : sanitize(entry),
    ]));
  }

  return value;
}

function markdownCell(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;").replace(/\r?\n/g, "<br>");
}

function summary(results: Result[]): string {
  const counts = statuses.map((status) => `| ${status} | ${results.filter((result) => result.status === status).length} |`);
  const fields: (keyof Result)[] = [
    "id", "description", "expected", "observed", "status", "reason", "category", "deterministic", "environment", "evidence",
  ];
  const rows = results.map((result) => `| ${fields.map((field) => markdownCell(result[field])).join(" | ")} |`);

  return [
    "# Live test report", "", "| Status | Count |", "| --- | ---: |", ...counts, "",
    `| ${fields.join(" | ")} |`, `| ${fields.map(() => "---").join(" | ")} |`, ...rows, "",
  ].join("\n");
}

async function writePrivateFile(filename: string, content: string): Promise<void> {
  const file = await open(filename, "w", 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(content, "utf8");
  } finally {
    await file.close();
  }
}

export async function writeReport(directory: string, results: Result[]): Promise<void> {
  const sanitized = sanitize(results) as Result[];

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writePrivateFile(path.join(directory, "results.json"), `${JSON.stringify(sanitized, null, 2)}\n`);
  await writePrivateFile(path.join(directory, "summary.md"), summary(sanitized));
}
