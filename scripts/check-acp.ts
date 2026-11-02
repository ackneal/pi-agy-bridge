import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { Connection } from "../src/extension/drivers/acp/connection.ts";
import { ensureInstallation } from "../src/extension/drivers/acp/installation.ts";
import { resolveRelease } from "../src/extension/drivers/acp/release.ts";

const help = `Usage: bun run check:acp [--cancel]
       bun run check:acp --help
Explicit invocation consents to downloading the pinned official ACP release and
sending live, potentially billable prompts to gemini-3.8-flash (thinking: low).
WARNING: normal host HOME/GEMINI_HOME and existing authentication are reused.
The backend may update host state/session history. No login/logout or token reads
are performed by this script. Prepare authentication externally before running.
Cleanup removes the temporary project/installation; if its deadline is exceeded,
scratch may remain and cleanup is FAIL. Private results.json is retained separately.
Deadline: 10 minutes total plus at most 5 seconds cleanup; each prompt: 60 seconds.
--cancel adds a live cancellation check after actual prompt text activity.
No executable overrides, scenario/environment flags, Pi, MCP, readers, offload or
compaction checks. Image evidence covers only one red pixel, not general vision.
Help is offline and does not create files or launch a backend.`;

type Status = "PASS" | "FAIL" | "MODEL_MISMATCH" | "NOT_SUPPORTED" | "NOT_REACHED" | "UNTESTED";
type Check = { status: Status; detail: string };
type PromptFact = { id: string; sessionId: string; text?: string; stopReason?: string; usage: Record<string, number> | null; usageUpdates: { used: number; size: number }[]; textMatched?: boolean };
const model = "gemini-3.8-flash";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};

async function main(cancel: boolean) {
  const reportDir = mkdtempSync(path.join(tmpdir(), "check-acp-results-"));
  const reportPath = path.join(reportDir, "results.json");
  const checks: Record<string, Check> = Object.fromEntries([
    "installation", "initialize", "new", "config", "instruction", "memory", "image", "load", "cancel", "cleanup",
  ].map(id => [id, { status: "NOT_REACHED", detail: "Not reached" }]));
  for (const id of ["MCP", "mockservers", "readers", "offload", "Pi", "compaction"]) checks[id] = { status: "UNTESTED", detail: "Outside direct ACP scope" };
  const prompts: PromptFact[] = [];
  const report = { schema: 1, backend: { version: "unresolved", distribution: "unresolved" }, initialization: {} as Record<string, unknown>, configuration: [] as { phase: string; id: string; requested: string; observed: string | boolean | undefined }[], model, thinkingLevel: "low", hostState: "Normal HOME/GEMINI_HOME reused; backend may persist state", checks, prompts,
    accounting: "Raw allowlisted PromptResponse.usage numbers and separate usage_update used/size; missing usage is null, not zero; no Pi mapping or thought requirement",
    limitation: "Single red-pixel check only; load replay excluded from prompt observations", outcome: "RUNNING" };
  const connections: Connection[] = [];
  const controller = new AbortController();
  let scratch: string | undefined;
  let installation: ReturnType<typeof ensureInstallation> | undefined;
  let active = "installation";
  let hardStop: ReturnType<typeof setTimeout> | undefined;
  const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  const stop = () => {
    controller.abort();
    for (const connection of connections) void connection.dispose().catch(() => {});
    hardStop ??= setTimeout(() => {
      checks.cleanup = { status: "FAIL", detail: `Cleanup deadline exceeded; scratch may remain: ${scratch ?? "not created"}` };
      report.outcome = "FAIL";
      save();
      process.exit(1);
    }, 5000);
  };
  const timer = setTimeout(stop, 600_000);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const bounded = async <T>(promise: Promise<T>) => {
    let abort!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("Interrupted or deadline"));
      controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) abort();
    });
    try { return await Promise.race([promise, interrupted]); }
    finally { controller.signal.removeEventListener("abort", abort); }
  };
  const record = (id: string, ok: boolean, detail: string, mismatch = false) => {
    checks[id] = { status: ok ? "PASS" : mismatch ? "MODEL_MISMATCH" : "FAIL", detail };
    if (!ok) {
      process.exitCode = 1;
      if (!mismatch) throw new Error("Assertion failed");
    }
  };
  let observation: { connection: Connection; sessionId: string; text: string; fact: PromptFact; pending: boolean; cancelSent: boolean; cancelTask?: Promise<void> } | undefined;
  const connect = (executable: string, args: string[], cwd: string) => {
    const connection = new Connection({ executable, args, cwd, requestTimeoutMs: 30_000,
      onUpdate: notification => {
        const current = observation;
        if (!current || current.connection !== connection || current.sessionId !== notification.sessionId || !current.pending) return;
        const update = notification.update;
        if (update.sessionUpdate === "usage_update" && Number.isFinite(update.used) && Number.isFinite(update.size)) current.fact.usageUpdates.push({ used: update.used, size: update.size });
        if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return;
        current.text = (current.text + update.content.text).slice(0, 16384);
        if (current.fact.id === "cancel" && update.content.text.trim() && !current.cancelSent && current.pending) {
          current.cancelSent = true;
          current.cancelTask = connection.notify(acp.methods.agent.session.cancel, { sessionId: current.sessionId });
          void current.cancelTask.catch(() => {});
        }
      },
    });
    connections.push(connection);
    return connection;
  };
  const configure = async (connection: Connection, sessionId: string, initial: acp.SessionConfigOption[]) => {
    let options = initial;
    for (const [id, value] of [["mode", "default"], ["model", model], ["thinking_level", "low"]] as const) {
      const option = options.find(entry => entry.id === id);
      const values = option?.type === "select" ? option.options.flatMap(entry => "group" in entry ? entry.options : [entry]) : [];
      record(active, values.some(entry => entry.value === value), `${id}: requested value must be advertised`);
      const response = await bounded(connection.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: id, value }));
      options = response.configOptions;
      const observed = options.find(entry => entry.id === id)?.currentValue;
      report.configuration.push({ phase: active, id, requested: value, observed });
      record(active, observed === value, `${id}: actual set_config_option response must confirm requested value`);
    }
    record(active, [["mode", "default"], ["model", model], ["thinking_level", "low"]].every(([id, value]) => options.find(entry => entry.id === id)?.currentValue === value), "Final config must retain all requested values");
    checks[active] = { status: "PASS", detail: "mode=default, model=gemini-3.8-flash, thinking_level=low advertised and confirmed in actual set_config_option responses" };
  };
  const prompt = async (connection: Connection, sessionId: string, id: string, content: acp.ContentBlock[], expected?: string) => {
    active = id;
    const fact: PromptFact = { id, sessionId, usage: null, usageUpdates: [] };
    prompts.push(fact);
    const current = { connection, sessionId, text: "", fact, pending: true, cancelSent: false } as NonNullable<typeof observation>;
    observation = current;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      expiry = setTimeout(() => {
        void (async () => {
          try {
            await Promise.race([connection.notify(acp.methods.agent.session.cancel, { sessionId }), new Promise(resolve => setTimeout(resolve, 200))]);
          } catch { /* Disposal is mandatory even when cancellation fails. */ }
          finally { await connection.dispose().catch(() => {}); }
        })();
        reject(new Error("Prompt deadline"));
      }, 60_000);
    });
    try {
      const request = connection.request(acp.methods.agent.session.prompt, { sessionId, prompt: content });
      void request.then(() => { current.pending = false; }, () => { current.pending = false; });
      const response = await bounded(Promise.race([request, timeout]));
      fact.stopReason = response.stopReason;
      fact.text = current.text;
      const usage = object(object(response).usage);
      if (Object.keys(usage).length) {
        fact.usage = {};
        for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedReadTokens", "cachedWriteTokens", "thoughtTokens"]) {
          const value = usage[key];
          if (typeof value === "number" && Number.isFinite(value)) fact.usage[key] = value;
        }
      }
      if (id === "cancel") {
        if (!current.cancelSent) checks.cancel = { status: "NOT_REACHED", detail: "Prompt finished before cancellation activity gate" };
        else {
          await bounded(current.cancelTask!);
          record(id, response.stopReason === "cancelled", "After text activity while pending, session/cancel must produce stopReason=cancelled");
        }
      } else {
        fact.textMatched = current.text.trim() === expected;
        record(id, response.stopReason === "end_turn", "Prompt must complete with end_turn");
        record(id, fact.textMatched, id === "image" ? "Bare RED expected for one red pixel only" : "Exact requested marker expected", true);
      }
    } finally {
      clearTimeout(expiry);
      observation = undefined;
      if (current.pending) await connection.dispose();
    }
  };

  console.log(`WARNING: reusing host HOME/GEMINI_HOME; live cost and host-state changes possible.\nReport: ${reportPath}`);
  try {
    scratch = mkdtempSync(path.join(tmpdir(), "check-acp-scratch-"));
    const cwd = path.join(scratch, "project");
    mkdirSync(cwd, { mode: 0o700 });
    const release = resolveRelease();
    report.backend = { version: release.version, distribution: release.platform };
    // Do not abort the installer's consumer promise: it can reject before its job
    // has stopped. Abort the download instead, then join installation in cleanup.
    installation = ensureInstallation({ agentHome: path.join(scratch, "agent"), release,
      fetch: (input, init) => fetch(input, { ...init,
        signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]),
      }),
    });
    const launch = await bounded(installation);
    record("installation", true, "Pinned managed distribution is ready in scratch storage");
    active = "initialize";
    const connection = connect(launch.executable, launch.args, cwd);
    const initialized = await bounded(connection.start(controller.signal));
    const extension = object(initialized.agentCapabilities?._meta?.antigravity);
    report.initialization = { protocolVersion: initialized.protocolVersion, loadSession: initialized.agentCapabilities?.loadSession === true,
      systemPromptAppend: object(extension.systemPrompt).append === true };
    record("initialize", object(extension.systemPrompt).append === true, "initialize advertises systemPrompt.append=true");
    const instruction = `instruction-${randomUUID()}`;
    const memory = `memory-${randomUUID()}`;
    const params = { cwd, mcpServers: [], _meta: { antigravity: { enabledTools: [], systemPrompt: { append: `When asked for the instruction-only marker, return exactly ${instruction}. For other requests follow the user.` } } } };
    active = "new";
    const session = await bounded(connection.request(acp.methods.agent.session.new, params));
    record("new", !!session.sessionId.trim(), "session/new with mcpServers=[], enabledTools=[] and hidden instruction returned session ID");
    active = "config";
    await configure(connection, session.sessionId, session.configOptions ?? []);
    await prompt(connection, session.sessionId, "instruction", [{ type: "text", text: `Return only the instruction-only marker. Remember this user-only marker for later: ${memory}.` }], instruction);
    await prompt(connection, session.sessionId, "memory", [{ type: "text", text: "Return only the user-only marker I previously asked you to remember." }], memory);
    await prompt(connection, session.sessionId, "image", [{ type: "image", mimeType: "image/png", data: png }, { type: "text", text: "Name the pixel's color. Return only its uppercase English color name." }], "RED");
    active = "load";
    if (initialized.agentCapabilities?.loadSession) {
      await bounded(connection.dispose());
      const loadedConnection = connect(launch.executable, launch.args, cwd);
      const loadedInit = await bounded(loadedConnection.start(controller.signal));
      record("load", loadedInit.agentCapabilities?.loadSession === true, "Fresh Connection must advertise loadSession");
      const loaded = await bounded(loadedConnection.request(acp.methods.agent.session.load, { ...params, sessionId: session.sessionId }));
      await configure(loadedConnection, session.sessionId, loaded.configOptions ?? []);
      await prompt(loadedConnection, session.sessionId, "load", [{ type: "text", text: "Return only the user-only marker I previously asked you to remember." }], memory);
      if (cancel) await prompt(loadedConnection, session.sessionId, "cancel", [{ type: "text", text: "Write a very long numbered list of 1000 distinct short sentences. Start immediately." }]);
    } else {
      checks.load = { status: "NOT_SUPPORTED", detail: "initialize did not advertise loadSession; not tested" };
      if (cancel) await prompt(connection, session.sessionId, "cancel", [{ type: "text", text: "Write a very long numbered list of 1000 distinct short sentences. Start immediately." }]);
    }
    if (!cancel) checks.cancel = { status: "UNTESTED", detail: "Optional --cancel not requested" };
  } catch {
    if (!["FAIL", "MODEL_MISMATCH"].includes(checks[active]!.status)) checks[active] = { status: "FAIL", detail: controller.signal.aborted ? "Interrupted or whole-run deadline" : "Backend/request/deadline failure (payload deliberately omitted)" };
    process.exitCode = 1;
  } finally {
    active = "cleanup";
    stop();
    if (installation) await Promise.allSettled([installation]);
    const disposed = await Promise.allSettled(connections.map(connection => connection.dispose()));
    let cleaned = disposed.every(result => result.status === "fulfilled");
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => { cleaned = false; });
    checks.cleanup = { status: cleaned ? "PASS" : "FAIL", detail: cleaned ? "Tracked connections disposed; scratch removed" : "Connection or scratch cleanup failed" };
    if (!cleaned) process.exitCode = 1;
    clearTimeout(timer);
    clearTimeout(hardStop);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    report.outcome = process.exitCode ? "FAIL" : "COMPLETE";
    save();
    for (const [id, result] of Object.entries(checks)) console.log(`${id}: ${result.status} — ${result.detail}`);
    console.log(`Report: ${reportPath}`);
  }
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") console.log(help);
else if (args.length > 1 || (args.length === 1 && args[0] !== "--cancel") || process.env.AGY_ACP_DIR || process.env.AGY_ACP_BIN || process.env.AGY_BRIDGE_DEBUG) {
  console.error("Rejected unknown flags/executable override or debug logging. Use --help (offline).");
  process.exitCode = 1;
} else await main(args[0] === "--cancel").catch(() => {
  console.error("Diagnostic setup/report failure (payload omitted).");
  process.exitCode = 1;
});
