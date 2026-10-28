import { stripVTControlCharacters } from "node:util";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { resolveAgyExecutable } from "./version.ts";
import { spawnAuthenticationPty, type AuthenticationPty } from "./auth-pty.ts";
import { fetchAgyUsage, parseAgyUsageOutput, type AgyUsage } from "./usage.ts";
import { AuthenticationRequiredError } from "../shared/types.ts";

const args = ["--print", "/usage"];
const invitation = "Authentication required. Please visit the URL to log in:";
const manual = "Or, paste the authorization code here and press Enter:";
const maxBytes = 64 * 1024;

function runAuthentication(
  path: string | undefined,
  signal: AbortSignal | undefined,
  interaction: ProviderAuthInteraction
): Promise<AgyUsage | undefined> {
  if (signal?.aborted) return Promise.reject(new Error("Antigravity CLI authentication was cancelled"));
  const executable = resolveAgyExecutable(path);

  return new Promise((resolve, reject) => {
    let pty: AuthenticationPty;
    let setupFailed = false;
    try {
      pty = spawnAuthenticationPty(executable, args, (message) => {
        queueMicrotask(() => {
          if (!setupFailed) finish(new Error(message));
        });
      });
    } catch {
      setupFailed = true;
      reject(new Error("Could not start the Antigravity CLI authentication process"));
      return;
    }
    const child = pty.child;
    let failure: Error | undefined;
    let closed = false;
    let prompt: AbortController | undefined;
    let urlSent = false;
    let progressSent = false;
    let diagnostics = "";
    let submittedCode: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const bytes = { stdout: 0, stderr: 0 };

    const finish = (error: Error) => {
      if (failure || closed) return;
      failure = error;
      prompt?.abort();
      clearTimeout(timer);
      pty.kill("SIGTERM");
      killTimer = setTimeout(() => pty.kill("SIGKILL"), 500);
    };
    const onAbort = () => finish(new Error("Antigravity CLI authentication was cancelled"));
    const timer = setTimeout(() => finish(new Error("Timed out waiting for Antigravity CLI authorization")), 180_000);

    const observe = (stream: keyof typeof bytes, chunk: string) => {
      if (failure) return;
      bytes[stream] += Buffer.byteLength(chunk);
      diagnostics += chunk;
      if (bytes.stdout + bytes.stderr > maxBytes) {
        finish(new Error("Antigravity CLI authentication output exceeded the allowed limit"));
        return;
      }
      const text = stripVTControlCharacters(diagnostics);

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
            if (failure || closed || promptSignal.aborted) return;
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
      prompt?.abort();
      clearTimeout(timer);
      clearTimeout(killTimer);
      pty.dispose();
      signal?.removeEventListener("abort", onAbort);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.stdin.off("error", onInputError);
      child.off("error", onError);
      child.off("close", onClose);
      if (failure) {
        reject(failure);
        return;
      }

      const text = stripVTControlCharacters(diagnostics);
      // Normalize the accumulated output before excluding fragmented PTY echoes.
      const report = submittedCode === undefined ? text : text.replaceAll(submittedCode, "[authorization code]");
      const usage = parseAgyUsageOutput(report);
      const hasQuota = usage !== undefined || report.includes("Quota") || report.includes("Limit Remaining");
      if (code === 0 && exitSignal === null && hasQuota) {
        resolve(usage);
        return;
      }

      const ttyFailure = /script:\s+(?:tcgetattr(?:\/ioctl)?|openpty)/i.test(text);
      const message = ttyFailure
        ? "Could not start an interactive terminal for Antigravity CLI authentication. Check your terminal permissions, or run `agy` in a terminal to authenticate, then retry `/login`."
        : `Could not determine Antigravity CLI authentication status (exitCode=${code ?? "none"}, signal=${exitSignal ?? "none"}, stdoutBytes=${bytes.stdout}, stderrBytes=${bytes.stderr})`;
      reject(new Error(message));
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
  });
}

export async function probeAgyAuthentication(
  agyPath?: string,
  signal?: AbortSignal,
  onUsage?: (usage: AgyUsage) => void
): Promise<boolean> {
  let usage: AgyUsage;
  try {
    usage = await fetchAgyUsage(agyPath, signal);
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return false;
    throw error;
  }

  onUsage?.(usage);
  return true;
}

export async function loginAgyAuthentication(
  interaction: ProviderAuthInteraction,
  agyPath?: string,
  onUsage?: (usage: AgyUsage) => void
): Promise<void> {
  if (await probeAgyAuthentication(agyPath, interaction.signal, onUsage)) return;
  const usage = await runAuthentication(agyPath, interaction.signal, interaction);
  if (usage) onUsage?.(usage);
}
