import { stripVTControlCharacters } from "node:util";
import { debugArtifact, isDebugEnabled } from "../shared/debug.ts";

const vocabulary = new Set("limit remaining authentication required error unknown command login logged in invalid unsupported print option update version permission denied network failed timeout help please run log status timed out".split(" "));
const summaryLimit = 2048;

export function summarizeAuthOutput(output: string): string {
  const lines = stripVTControlCharacters(output).split(/\r\n|[\r\n]/);
  return lines.map((line) => {
    const quotaLine = /\bLimit Remaining\s+\d+(?:\.\d+)?%(?=\s|$)/i.test(line);
    return line.split(/\s+/).filter(Boolean).map((token) => {
      // Treat each whitespace-delimited token as indivisible: URL queries and
      // code/token fragments must never be mined for recognizable words.
      const word = token.match(/^([a-z]+)[.,:!?]?$/i)?.[1]?.toLowerCase();
      if (word && vocabulary.has(word)) return word;
      if (quotaLine && /^\d{1,3}(?:\.\d{1,2})?%$/.test(token) && Number(token.slice(0, -1)) <= 100) return token;
      return "[redacted]";
    }).join(" ");
  }).join("\n").slice(0, summaryLimit);
}

export function recordAuthProbeDiagnostics(source: string, executable: string, args: readonly string[], code: number | null, signal: NodeJS.Signals | null, streams: { stdout: string; stderr: string }, bytes: { stdout: number; stderr: number }): void {
  if (!isDebugEnabled()) return;

  debugArtifact("auth-probe", {
    source, executable, args, exitCode: code, exitSignal: signal,
    stdoutBytes: bytes.stdout, stderrBytes: bytes.stderr,
    stdoutSummary: summarizeAuthOutput(streams.stdout), stderrSummary: summarizeAuthOutput(streams.stderr),
  });
}
