import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { resolveAgyExecutable } from "./version.ts";
import { spawnAuthenticationPty, type AuthenticationPty } from "./auth-pty.ts";

import { recordAuthProbeDiagnostics, summarizeAuthOutput } from "./auth-diagnostics.ts";
import { isDebugEnabled } from "../shared/debug.ts";

const args = ["--print", "/usage"];
const required = /authentication required/i;
const invitation = "Authentication required. Please visit the URL to log in:";
const manual = "Or, paste the authorization code here and press Enter:";
const maxBytes = 64 * 1024;

function runAuthentication(path: string | undefined, signal: AbortSignal | undefined, interaction?: ProviderAuthInteraction): Promise<boolean> {
  if (signal?.aborted) return Promise.reject(new Error("Antigravity CLI authentication was cancelled"));
  const executable = resolveAgyExecutable(path);

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    let pty: AuthenticationPty | undefined;
    let setupFailed = false;
    try {
      if (interaction) {
        pty = spawnAuthenticationPty(executable, args, (message) => {
          queueMicrotask(() => {
            if (!setupFailed) finish(new Error(message));
          });
        });
        child = pty.child;
      } else {
        child = spawn(executable, args, { detached: true, stdio: "pipe" });
      }
    } catch {
      setupFailed = true;
      reject(new Error("Could not start the Antigravity CLI authentication process"));
      return;
    }
    let outcome: boolean | Error | undefined;
    let closed = false;
    let prompt: AbortController | undefined;
    let urlSent = false;
    let progressSent = false;
    let escalated = false;
    let diagnostics = "";
    let submittedCode: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const buffers = { stdout: "", stderr: "" };
    const probeDiagnostics = !interaction && isDebugEnabled() ? { stdout: "", stderr: "" } : undefined;
    const probeBytes = { stdout: 0, stderr: 0 };

    const kill = (sig: NodeJS.Signals) => {
      if (sig === "SIGKILL") escalated = true;
      if (pty) {
        pty.kill(sig);
      } else if (child.pid) {
        try { process.kill(-child.pid, sig); } catch { child.kill(sig); }
      }
    };
    const finish = (result: boolean | Error) => {
      if (outcome !== undefined || closed) return;
      outcome = result;
      prompt?.abort();
      clearTimeout(timer);
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 500);
    };
    const onAbort = () => finish(new Error("Antigravity CLI authentication was cancelled"));
    const timer = setTimeout(() => finish(new Error(interaction ? "Timed out waiting for Antigravity CLI authorization" : "Antigravity CLI authentication check timed out")), interaction ? 180_000 : 30_000);

    const observe = (stream: keyof typeof buffers, chunk: string) => {
      if (probeDiagnostics) {
        probeBytes[stream] += Buffer.byteLength(chunk);
        const captured = probeDiagnostics[stream] + chunk;
        probeDiagnostics[stream] = captured.length > maxBytes
          ? captured.slice(0, maxBytes).replace(/\S*$/, "[redacted]")
          : captured;
      }
      if (outcome !== undefined) return;
      buffers[stream] += chunk;
      diagnostics += chunk;
      if (Buffer.byteLength(diagnostics) > maxBytes) {
        finish(new Error("Antigravity CLI authentication output exceeded the allowed limit"));
        return;
      }
      const text = stripVTControlCharacters(diagnostics);
      if (!interaction) {
        if (required.test(text)) finish(false);
        return;
      }

      try {
        const start = text.indexOf(invitation);
        if (!urlSent && start !== -1) {
          const match = text.slice(start + invitation.length).match(/https?:\/\/[^\s]+(?=\s)/);
          if (match) {
            const url = new URL(match[0]);
            if (url.protocol !== "https:" || url.hostname !== "accounts.google.com" || url.pathname !== "/o/oauth2/auth" || url.port || url.username || url.password) {
              finish(new Error("Antigravity CLI returned an untrusted authentication URL"));
              return;
            }
            urlSent = true;
            interaction.notify({ type: "auth_url", url: url.href });
          }
        }
        if (/timed out|authentication timeout/i.test(text)) {
          finish(new Error("Timed out waiting for Antigravity CLI authorization"));
          return;
        }
        if (!progressSent && /waiting/i.test(text)) {
          progressSent = true;
          interaction.notify({ type: "progress", message: "Waiting for Antigravity CLI authentication" });
        }
        if (urlSent && !prompt && text.includes(manual)) {
          prompt = new AbortController();
          const promptSignal = prompt.signal;
          void interaction.prompt({ type: "manual_code", message: "Paste the authorization code from your browser", signal: promptSignal }).then((code) => {
            if (outcome !== undefined || closed || promptSignal.aborted) return;
            // Keep control characters and forged report lines out of PTY input.
            if (code.length > 8192 || !/^[A-Za-z0-9._~+/%=-]+$/.test(code)) {
              finish(new Error("Invalid authorization code"));
              return;
            }
            progressSent = true;
            interaction.notify({ type: "progress", message: "Completing Antigravity CLI authentication" });
            submittedCode = code;
            child.stdin.write(`${code}\n`, (error) => {
              if (error) finish(new Error("Could not submit authorization code"));
            });
          }).catch(() => {
            if (!promptSignal.aborted) finish(new Error("Authorization code entry was cancelled"));
          });
        }
      } catch {
        finish(new Error("Antigravity CLI authentication failed"));
      }
    };
    const onStdout = (chunk: string) => observe("stdout", chunk);
    const onStderr = (chunk: string) => observe("stderr", chunk);
    const onError = () => finish(new Error("Could not start the Antigravity CLI authentication process"));
    const onInputError = () => finish(new Error("Could not send input to the Antigravity CLI authentication process"));
    const onClose = (code: number | null, exitSignal: NodeJS.Signals | null) => {
      closed = true;
      if (probeDiagnostics) recordAuthProbeDiagnostics(import.meta.url, executable, args, code, exitSignal, probeDiagnostics, probeBytes);
      prompt?.abort();
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (!escalated) kill("SIGKILL");
      pty?.dispose();
      signal?.removeEventListener("abort", onAbort);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.stdin.off("error", onInputError);
      child.off("error", onError);
      child.off("close", onClose);
      if (typeof outcome === "boolean") {
        resolve(outcome);
        return;
      }
      if (outcome instanceof Error) {
        reject(outcome);
        return;
      }

      const text = stripVTControlCharacters(diagnostics);
      // Normalize the accumulated output before excluding fragmented PTY echoes.
      const report = submittedCode === undefined ? text : text.replaceAll(submittedCode, "[authorization code]");
      const hasQuota = report.includes("Quota") || report.includes("Limit Remaining");
      if (code === 0 && exitSignal === null && hasQuota) {
        resolve(true);
        return;
      }

      const ttyFailure = /script:\s+(?:tcgetattr(?:\/ioctl)?|openpty)/i.test(text);
      const message = ttyFailure
        ? "Could not start an interactive terminal for Antigravity CLI authentication. Check your terminal permissions, or run `agy` in a terminal to authenticate, then retry `/login`."
        : `Could not determine Antigravity CLI authentication status (exitCode=${code ?? "none"}, signal=${exitSignal ?? "none"}, stdoutBytes=${Buffer.byteLength(buffers.stdout)}, stderrBytes=${Buffer.byteLength(buffers.stderr)})`;
      const response = !interaction
        ? `\nAntigravity CLI response (redacted): stdout=${JSON.stringify(summarizeAuthOutput(buffers.stdout))} stderr=${JSON.stringify(summarizeAuthOutput(buffers.stderr))}`
        : "";
      reject(new Error(message + response));
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.stdin.on("error", onInputError);
    child.on("error", onError);
    child.on("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (!pty) child.stdin.end();
  });
}

export async function probeAgyAuthentication(agyPath?: string, signal?: AbortSignal): Promise<boolean> {
  return runAuthentication(agyPath, signal);
}

export async function loginAgyAuthentication(interaction: ProviderAuthInteraction, agyPath?: string): Promise<void> {
  if (await probeAgyAuthentication(agyPath, interaction.signal)) return;
  await runAuthentication(agyPath, interaction.signal, interaction);
}
