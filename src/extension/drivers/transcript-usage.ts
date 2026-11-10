import type { Usage } from "@earendil-works/pi-ai";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { debugLog } from "../shared/debug.ts";

const TAIL_BYTES = 1024 * 1024;

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseModelUsage(row: Record<string, unknown>): { step: number; timestamp: number; usage: Usage } | undefined {
  if (row.type !== "PLANNER_RESPONSE" || row.status !== "DONE" || !isTokenCount(row.step_index)) return undefined;
  if (typeof row.created_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(row.created_at)) return undefined;
  const timestamp = Date.parse(row.created_at);
  if (!Number.isFinite(timestamp)) return undefined;

  const input = row.input_tokens;
  const output = row.output_tokens;
  const cacheRead = row.cache_read_tokens;
  const cacheWrite = row.cache_write_tokens === undefined ? 0 : row.cache_write_tokens;
  if (!isTokenCount(input) || !isTokenCount(output) || !isTokenCount(cacheRead) || !isTokenCount(cacheWrite)) return undefined;
  const totalTokens = input + cacheRead + cacheWrite + output;
  if (!Number.isSafeInteger(totalTokens)) return undefined;

  return {
    step: row.step_index,
    timestamp,
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

export async function readLastCallUsage(
  home: string,
  driver: "cli" | "acp",
  sessionId: string,
): Promise<{ step: number; timestamp: number; usage: Usage } | undefined> {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || (driver !== "cli" && driver !== "acp")) return undefined;
  const filename = path.join(home, `antigravity-${driver}`, "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");

  try {
    // Nonblocking open also lets us reject FIFOs without waiting for a writer.
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let tail: Buffer;
    let start: number;
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return undefined;
      start = Math.max(0, stat.size - TAIL_BYTES);
      tail = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
      let offset = 0;
      while (offset < tail.length) {
        const { bytesRead } = await file.read(tail, offset, tail.length - offset, start + offset);
        if (bytesRead === 0) return undefined;
        offset += bytesRead;
      }
      // A concurrent append/truncate makes this snapshot unsuitable for freshness.
      if ((await file.stat()).size !== stat.size) return undefined;
    } finally {
      await file.close();
    }

    // The first row can be cut off, including in the middle of a UTF-8 character.
    if (start > 0) {
      const newline = tail.indexOf(10);
      if (newline < 0) return undefined;
      tail = tail.subarray(newline + 1);
    }
    const lines = tail.toString("utf8").split("\n");
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]!.trim();
      if (!line) continue;
      const row: unknown = JSON.parse(line);
      if (typeof row !== "object" || row === null || Array.isArray(row)) return undefined;
      const record = row as Record<string, unknown>;
      if (record.source === "MODEL") return parseModelUsage(record);
      if (record.source !== "TOOL" && record.source !== "USER") return undefined;
    }
    return undefined;
  } catch (error) {
    // Error messages and paths can contain private transcript/session data.
    const errno = error instanceof Error ? (error as NodeJS.ErrnoException).errno : undefined;
    debugLog("transcript-usage", { errno: typeof errno === "number" ? errno : undefined });
    return undefined;
  }
}
