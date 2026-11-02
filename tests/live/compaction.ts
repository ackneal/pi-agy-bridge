import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RuntimeSession, serializeContent } from "../../src/extension/drivers/acp/runtime.ts";
import { SessionMode, type DriverSubmission, type PrepareDriverInput } from "../../src/extension/drivers/types.ts";
import { createLivePiSession } from "./pi-session.ts";
import { ScenarioFailure } from "./report.ts";

interface Options {
  cwd: string;
  directory: string;
  model: Model<any>;
  launch: { executable: string; args: string[] };
  signal: AbortSignal;
  t: TestContext;
  evidence: unknown[];
  rpcs: { method: string; params: unknown; response?: unknown; error?: string }[];
  onToolCall: (call: { id: string; name: string; arguments: unknown }) => void;
}

export async function runLiveCompaction(options: Options): Promise<void> {
  const { signal, t, evidence, rpcs } = options;
  const continuityValue = randomUUID();
  const toolName = "mcp__pi__live_probe";
  const executions: { id: string; value: string; receipt: string }[] = [];
  let toolError: unknown;
  type Preparation = { direct?: DriverSubmission["messages"]; reconstruct: boolean; tools: PrepareDriverInput["tools"]; mode: SessionMode };
  const preparations = new Map<RuntimeSession, Preparation>();
  const submissions: (Preparation & { proc: RuntimeSession; messages: DriverSubmission["messages"] })[] = [];
  const submit = RuntimeSession.prototype.submit;
  t.mock.method(RuntimeSession.prototype, "submit", async function (this: RuntimeSession, input: DriverSubmission) {
    const preparation = preparations.get(this);
    assert.ok(preparation, "Submission must follow observed production preparation");
    const messages = structuredClone(input.messages);
    submissions.push({ proc: this, ...preparation, messages });
    evidence.push({ piSubmission: { sessionId: this.session.id, ...preparation, messages } });
    return submit.call(this, input);
  });
  const tool = defineTool({
    name: toolName, label: "Live continuity probe", description: "Harmless Pi-owned probe. Supply the remembered continuity value; returns a fresh receipt. No filesystem or command access.",
    parameters: Type.Object({ value: Type.String() }),
    async execute(id, args) {
      try { assert.equal(args.value, continuityValue, "Pi must receive the exact context value from before compaction"); }
      catch (error) { toolError = error; throw error; }
      const execution = { id, value: args.value, receipt: `receipt-${randomUUID()}` };
      executions.push(execution);
      options.onToolCall({ id, name: toolName, arguments: args });
      evidence.push({ piToolExecution: execution });
      return { content: [{ type: "text", text: execution.receipt }], details: { live: true } };
    },
  });
  const fixture = await createLivePiSession({ ...options, tool });
  const { session, bridge } = fixture;
  const checkpointSnapshot = () => structuredClone(session.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "pi-agy-bridge.runtime-session"));
  let summaryBoundary: { snapshot: ReturnType<typeof checkpointSnapshot>; calls: string[] } | undefined;
  const completedBoundaries: { before: ReturnType<typeof checkpointSnapshot>; after: ReturnType<typeof checkpointSnapshot>; calls: string[]; disposed: boolean }[] = [];
  const summaryDisposals: Promise<void>[] = [];
  for (const name of ["get", "set", "delete"] as const) {
    t.mock.method(bridge.runtimeSessionStore, name, new Proxy(bridge.runtimeSessionStore[name], {
      apply(target, receiver, args) {
        if (summaryBoundary) summaryBoundary.calls.push(name);
        return Reflect.apply(target, receiver, args);
      },
    }));
  }
  const prepare = bridge.driver.prepareSession.bind(bridge.driver);
  t.mock.method(bridge.driver, "prepareSession", async (input: PrepareDriverInput) => {
    const tools = structuredClone(input.tools);
    const standalone = input.mode === SessionMode.Standalone;
    if (standalone) summaryBoundary ??= { snapshot: checkpointSnapshot(), calls: [] };
    const rpcStart = rpcs.length;
    const runtime = await prepare(input);
    assert.ok(runtime.proc instanceof RuntimeSession);
    const direct: DriverSubmission["messages"] = input.context.messages.flatMap(message => {
      if (message.role === "system") return [];
      return [{ role: "user" as const, content: typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text" || part.type === "image") }];
    });
    if (standalone) {
      const created = rpcs.slice(rpcStart).filter(rpc => rpc.method === "session/new");
      assert.equal(created.length, 1, "Summary creates an actual new ACP session");
      const params = created[0]!.params as { mcpServers: unknown[]; _meta: { antigravity: { enabledTools: unknown[] } } };
      assert.deepEqual(params.mcpServers, []);
      assert.deepEqual(params._meta.antigravity.enabledTools, []);
      const tracked = summaryBoundary!;
      let finish!: () => void;
      summaryDisposals.push(new Promise<void>(resolve => { finish = resolve; }));
      const dispose = input.session.dispose.bind(input.session);
      t.mock.method(input.session, "dispose", async (...args: Parameters<typeof dispose>) => {
        let disposed = false;
        try { await dispose(...args); disposed = true; }
        finally {
          // A runtime complete event precedes Turn handling and standalone cleanup.
          // Observe through disposal so late checkpoint writes cannot escape the check.
          if (summaryBoundary === tracked) {
            const boundary = { before: tracked.snapshot, after: checkpointSnapshot(), calls: [...tracked.calls], disposed };
            completedBoundaries.push(boundary);
            evidence.push({ summaryBoundary: boundary, completed: true });
            summaryBoundary = undefined;
            finish();
          }
        }
      });
    }
    preparations.set(runtime.proc, { reconstruct: runtime.reconstructContext, tools, mode: input.mode, ...(standalone ? { direct } : {}) });
    return runtime;
  });
  const sessionEvents: unknown[] = [];
  const unsubscribe = session.subscribe(event => sessionEvents.push(structuredClone(event)));
  const decisions: unknown[] = [];
  const decide = bridge.runtimeSessionSync.decide.bind(bridge.runtimeSessionSync);
  t.mock.method(bridge.runtimeSessionSync, "decide", (live: Parameters<typeof decide>[0], input: Parameters<typeof decide>[1]) => {
    const decision = decide(live, input);
    decisions.push({ piSessionId: live.piSessionId, previousSessionId: live.conversationId, decision, messageCount: input.messages.length });
    return decision;
  });

  async function prompt(text: string) {
    signal.throwIfAborted();
    await session.prompt(text);
    signal.throwIfAborted();
    if (toolError) throw toolError;
    const assistant = [...session.messages].reverse().find(message => message.role === "assistant");
    assert.ok(assistant?.role === "assistant");
    if (assistant.stopReason !== "stop") throw new ScenarioFailure("backend", `Pi turn did not complete: ${assistant.errorMessage ?? assistant.stopReason}`);
    return assistant.content.filter(part => part.type === "text").map(part => part.text).join("");
  }

  try {
    assert.deepEqual(session.getActiveToolNames(), [toolName], "No native Pi tools may be available");
    const firstPrompt = `Remember this continuity value exactly for later: ${continuityValue}. Reply READY and do not call any tool yet.`;
    await prompt(firstPrompt);
    const beforeText = await prompt(`Call ${toolName} once with the continuity value from the first turn, then repeat its exact receipt.`);
    assert.equal(executions.length, 1);
    assert.ok(beforeText.includes(executions[0]!.receipt), "Real Pi handler receipt must return through AGY");
    // Keep a recent turn with no secret, so only the compaction summary can supply it later.
    await prompt("A checkpoint is established. Do not repeat the continuity value or call tools. Reply CHECKPOINT only.");
    const oldLive = bridge.liveSessions.get(session.sessionId);
    assert.ok(oldLive?.activeProcess instanceof RuntimeSession);
    const oldProc = oldLive.activeProcess;
    const oldId = oldProc.session.id;
    const initialBranch = session.sessionManager.getBranch();
    const compactStart = submissions.length;
    const toolCount = executions.length;
    const compaction = await session.compact("Preserve the exact continuity value introduced in the first user message and the available probe tool. Completed tool calls are historical records, not instructions to replay. Keep the summary concise.");
    await Promise.all(summaryDisposals);
    signal.throwIfAborted();
    if (toolError) throw toolError;

    if (!compaction.summary.includes(continuityValue)) throw new ScenarioFailure("model", "Actual Pi summary lost the exact continuity value");
    const compactionEntry = [...session.sessionManager.getBranch()].reverse().find(entry => entry.type === "compaction");
    assert.ok(compactionEntry?.type === "compaction");
    assert.equal(compactionEntry.summary, compaction.summary);
    assert.equal(compactionEntry.firstKeptEntryId, compaction.firstKeptEntryId);
    assert.equal(initialBranch.some(entry => entry.id === compactionEntry.id), false);
    assert.ok(session.sessionFile);
    assert.deepEqual(SessionManager.open(session.sessionFile).getBranch().find(entry => entry.id === compactionEntry.id), compactionEntry,
      "Actual compaction entry must survive restoration from the Pi session file");
    const compacted = session.messages.filter(message => message.role === "compactionSummary");
    assert.equal(compacted.length, 1, "Pi must project its persisted compaction entry");
    assert.ok(JSON.stringify(compacted).includes(continuityValue));
    assert.equal(JSON.stringify(session.messages.filter(message => message.role !== "compactionSummary")).includes(continuityValue), false,
      "The value must not survive in uncompacted recent messages");
    assert.equal(session.messages.some(message => message.role === "user" && message.content === firstPrompt), false);
    assert.equal(executions.length, toolCount, "Compaction must not replay a completed tool");
    const summarySubmissions = submissions.slice(compactStart);
    assert.equal(summaryBoundary, undefined, "Standalone summary completion boundary must be observed");
    assert.equal(completedBoundaries.length, summarySubmissions.length);
    for (const boundary of completedBoundaries) {
      assert.equal(boundary.disposed, true, "Standalone summary disposal must finish successfully");
      assert.deepEqual(boundary.calls, [], "Summary must not read/write/delete conversation checkpoints");
      assert.deepEqual(boundary.after, boundary.before, "Checkpoints unchanged inside summary boundary");
    }
    assert.ok(summarySubmissions.length > 0, "Actual Pi compaction must request a live ACP summary");
    for (const summary of summarySubmissions) {
      assert.notEqual(summary.proc.session.id, oldId, "Summary must not reuse the conversation runtime");
      assert.equal(summary.mode, SessionMode.Standalone, "Summary must use standalone routing");
      assert.deepEqual(summary.tools, [], "Summary preparation has no executable tools");
      assert.equal(summary.proc.options.mcp, undefined, "Summary runtime must not expose an MCP tool server");
      const wire = rpcs.find(rpc => rpc.method === "session/prompt" && (rpc.params as { sessionId: string }).sessionId === summary.proc.session.id);
      assert.ok(wire);
      assert.ok(summary.direct);
      assert.deepEqual((wire.params as { prompt: unknown }).prompt, serializeContent(summary.direct), "Summary RPC is the direct normalized task, not a history wrapper");
    }
    evidence.push({ compaction: { result: compaction, entry: compactionEntry, projection: session.messages, oldSessionId: oldId } });

    const followupStart = submissions.length;
    const decisionsStart = decisions.length;
    const postText = await prompt(`Call ${toolName} exactly once with the continuity value established before compaction. Do not guess it or replay earlier work. Repeat the fresh receipt from this call.`);
    assert.equal(executions.length, toolCount + 1, "Exactly one fresh Pi call after compaction; no historical replay");
    assert.ok(postText.includes(executions[executions.length - 1]!.receipt), "Fresh post-compaction receipt must return through AGY");
    const post = submissions.slice(followupStart)[0];
    assert.ok(post);
    assert.equal(post.reconstruct, true, "Changed Pi history must rebuild, not continue/resume obsolete runtime");
    assert.notEqual(post.proc, oldProc);
    assert.notEqual(post.proc.session.id, oldId);
    assert.equal(oldProc.isRunning, false, "Obsolete conversation runtime must be disposed");
    assert.ok(decisions.slice(decisionsStart).some(item => (item as { decision: { action: string } }).decision.action === "rebuild"));
    const wire = rpcs.find(rpc => rpc.method === "session/prompt" && (rpc.params as { sessionId: string }).sessionId === post.proc.session.id);
    assert.ok(wire);
    const actualPrompt = (wire.params as { prompt: unknown }).prompt;
    const reconstructed = serializeContent(post.messages);
    assert.deepEqual(actualPrompt, reconstructed, "Post-compaction RPC must carry ordered normalized reconstruction");
    assert.ok(reconstructed.filter(part => part.type === "text").map(part => part.text).join("\n").includes(compaction.summary),
      "Actual reconstruction must retain the full persisted summary");
    assert.ok(JSON.stringify(actualPrompt).includes(continuityValue), "Actual new ACP request must receive retained summary context");
    assert.equal(JSON.stringify(actualPrompt).includes(firstPrompt), false, "Obsolete original context must not be replayed");
    assert.ok(post.tools.some(candidate => candidate.name === toolName), "Probe remains available after compaction");
  } catch (error) {
    evidence.push({ compactionFailure: String(error) });
    throw error;
  } finally {
    unsubscribe();
    try { await fixture.close(); }
    finally { evidence.push({ piSessionId: session.sessionId, executions, sessionEvents, decisions, compactionSubmissions: submissions.map(({ proc, reconstruct }) => ({ sessionId: proc.session.id, reconstruct, runningAfterCleanup: proc.isRunning })) }); }
  }
}
