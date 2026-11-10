import assert from "node:assert/strict";
import fs, { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import type { PromptResponse } from "@agentclientprotocol/sdk/unstable";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { AcpSessionClient, RuntimeSession, serializeContent, type RuntimeConnection } from "./runtime.ts";
import type { BridgeMessage, RuntimeEvent } from "../types.ts";

function option(id: string, value: string): Extract<acp.SessionConfigOption, { type: "select" }> {
  return { id, name: id, type: "select", currentValue: "default", options: [{ name: value, value }] };
}

class MockConnection implements RuntimeConnection {
  isRunning = true;
  sessionId = "mock-session-id";
  configOptions: acp.SessionConfigOption[] = [option("model", "gemini-3.8-flash"), option("thought_level", "high")];
  initialized: acp.InitializeResponse = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
  requests: { method: string; params: unknown }[] = [];
  notifications: { method: string; params: unknown }[] = [];
  listeners = new Set<(notification: acp.SessionNotification) => void | Promise<void>>();
  setConfig: (params: acp.SetSessionConfigOptionRequest, method: string) => acp.SetSessionConfigOptionResponse = (params) => {
    this.configOptions = this.configOptions.map((entry) => entry.type === "select" && entry.id === params.configId && typeof params.value === "string" ? { ...entry, currentValue: params.value } : entry);
    return { configOptions: this.configOptions };
  };
  onSession: (() => Promise<void>) | undefined;
  onPrompt: (() => Promise<acp.PromptResponse>) | undefined;

  async start(): Promise<acp.InitializeResponse> { return this.initialized; }

  onSessionUpdate(handler: (notification: acp.SessionNotification) => void | Promise<void>): () => void {
    this.listeners.add(handler);
    return () => { this.listeners.delete(handler); };
  }

  async update(sessionId = "mock-session-id", text = "hello"): Promise<void> {
    for (const listener of this.listeners) {
      await listener({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
    }
  }

  request(method: "session/new", params: acp.NewSessionRequest): Promise<acp.NewSessionResponse>;
  request(method: "session/load", params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse>;
  request(method: "session/set_config_option" | "session/setConfigOption", params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse>;
  request(method: "session/prompt", params: acp.PromptRequest): Promise<acp.PromptResponse>;
  async request(method: string, params: acp.NewSessionRequest | acp.LoadSessionRequest | acp.SetSessionConfigOptionRequest | acp.PromptRequest): Promise<acp.NewSessionResponse | acp.LoadSessionResponse | acp.SetSessionConfigOptionResponse | acp.PromptResponse> {
    this.requests.push({ method, params });
    if (method === "session/new" || method === "session/load") {
      await this.onSession?.();
      return { sessionId: this.sessionId, configOptions: this.configOptions };
    }
    if ("configId" in params) return this.setConfig(params, method);
    if (method === "session/prompt") return this.onPrompt?.() ?? { stopReason: "end_turn" };
    throw new Error(`Unexpected request: ${method}`);
  }

  async notify(method: string, params: unknown): Promise<void> { this.notifications.push({ method, params }); }
  async dispose(): Promise<void> { this.isRunning = false; }
}

const options = { cwd: "/mock/cwd", model: "gemini-3.8-flash" };
const model: Model<"google-generative-ai"> = {
  id: options.model, name: options.model, api: "google-generative-ai", provider: "google", baseUrl: "https://example.com",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
};

const configCases: { name: string; arrange: (connection: MockConnection) => void; effort?: "high"; error?: RegExp }[] = [
  { name: "applies model and thought_level", arrange: () => {}, effort: "high" },
  { name: "supports thinking_level alias", arrange: (c) => { c.configOptions[1] = option("thinking_level", "high"); }, effort: "high" },
  { name: "accepts grouped options", arrange: (c) => { c.configOptions[0] = { ...option("model", options.model), options: [{ group: "models", name: "Models", options: [{ name: options.model, value: options.model }] }] }; } },
  { name: "rejects missing model", arrange: (c) => { c.configOptions = []; }, error: /required configuration is unavailable: model/ },
  { name: "rejects non-select model", arrange: (c) => { c.configOptions[0] = { id: "model", name: "Model", type: "boolean", currentValue: false }; }, error: /required configuration is unavailable: model/ },
  { name: "rejects unsupported model", arrange: (c) => { c.configOptions[0] = option("model", "other"); }, error: /unsupported model: gemini/ },
  { name: "rejects missing effort", arrange: (c) => { c.configOptions = [option("model", options.model)]; }, effort: "high", error: /required configuration is unavailable: thinking_level/ },
  { name: "rejects unsupported effort", arrange: (c) => { c.configOptions[1] = option("thought_level", "low"); }, effort: "high", error: /unsupported thought_level: high/ },
  { name: "rejects unapplied model", arrange: (c) => { c.setConfig = () => ({ configOptions: c.configOptions }); }, error: /did not apply the requested model/ },
  { name: "rejects missing returned option", arrange: (c) => { c.setConfig = () => ({ configOptions: [] }); }, error: /did not apply the requested model/ },
  { name: "rejects unapplied effort", arrange: (c) => { c.setConfig = (p) => ({ configOptions: c.configOptions.map((o) => o.type === "select" && o.id === "model" && typeof p.value === "string" ? { ...o, currentValue: p.value } : o) }); }, effort: "high", error: /did not apply the requested thought_level/ },
  { name: "detects effort resetting model", arrange: (c) => { c.setConfig = (p) => { c.configOptions = c.configOptions.map((o) => o.type === "select" && typeof p.value === "string" ? { ...o, currentValue: o.id === p.configId ? p.value : "default" } : o); return { configOptions: c.configOptions }; }; }, effort: "high", error: /did not apply the requested model/ },
  { name: "falls back for method not found", arrange: (c) => { const apply = c.setConfig; c.setConfig = (p, method) => { if (method === "session/set_config_option") throw new Error("Method not found: -32601"); return apply(p, method); }; } },
  { name: "does not swallow other RPC errors", arrange: (c) => { c.setConfig = () => { throw new Error("permission denied"); }; }, error: /permission denied/ },
  { name: "verifies legacy response too", arrange: (c) => { c.setConfig = (_, method) => { if (method === "session/set_config_option") throw new Error("Method not found: -32601"); return { configOptions: c.configOptions }; }; }, error: /did not apply the requested model/ },
];

describe("AcpSessionClient configuration", () => {
  for (const row of configCases) {
    test(row.name, async (t) => {
      const connection = new MockConnection();
      row.arrange(connection);
      const client = new AcpSessionClient({ ...options, connection, effort: row.effort, onUpdate: () => {} });
      t.after(() => client.dispose());

      if (row.error) {
        await assert.rejects(client.prepare(), row.error);
        assert.equal(client.isRunning, false);
        assert.equal(connection.isRunning, false);
        assert.equal(connection.listeners.size, 0);
      } else {
        await client.prepare();
        assert.equal(client.isRunning, true);
        assert.equal(connection.configOptions.find((o) => o.id === "model")?.currentValue, options.model);
        assert.ok(connection.requests.some((r) => r.method === "session/set_config_option"));
        if (row.effort) {
          const effort = connection.configOptions.find((o) => o.id === "thought_level" || o.id === "thinking_level");
          assert.equal(effort?.currentValue, row.effort);
        }
        if (row.name === "falls back for method not found") {
          assert.ok(connection.requests.some((r) => r.method === "session/setConfigOption"));
        }
      }
    });
  }
});

describe("AcpSessionClient lifecycle", () => {
  for (const standalone of [false, true]) {
    for (const restored of [false, true]) {
      test(`prepare and cancel: standalone=${standalone}, restored=${restored}`, async (t) => {
        const connection = new MockConnection();
        const updates: acp.SessionNotification[] = [];
        connection.onSession = () => connection.update();
        const client = new AcpSessionClient({ ...options, connection, standalone, sessionId: restored ? "mock-session-id" : undefined, systemPrompt: "instructions", onUpdate: (n) => { updates.push(n); } });
        t.after(() => client.dispose());

        await Promise.all([client.prepare(), client.prepare()]);
        assert.equal(client.id, "mock-session-id");
        assert.equal(connection.requests.filter((r) => r.method === (restored ? "session/load" : "session/new")).length, 1);
        assert.deepEqual(connection.requests[0]?.params, {
          cwd: options.cwd, mcpServers: [], _meta: { antigravity: { enabledTools: standalone ? [] : ["read_file"], systemPrompt: { append: "instructions" } } },
          ...(restored ? { sessionId: "mock-session-id" } : {}),
        });
        assert.deepEqual(updates, []);
        await connection.update("other-session");
        assert.equal(updates.length, 0);
        await connection.update();
        assert.equal(updates.length, 1);
        assert.equal((await client.prompt([{ type: "text", text: "hi" }])).stopReason, "end_turn");
        await assert.rejects(client.prompt([]), /must not be empty/);
        await client.cancel();
        await connection.update();
        assert.equal(updates.length, 1);
        assert.equal(connection.listeners.size, 0);
        assert.deepEqual(connection.notifications, [{ method: "session/cancel", params: { sessionId: client.id } }]);
        assert.equal(client.isRunning, false);
      });
    }
  }
});

describe("AcpSessionClient preparation guards", () => {
  const cases = [
    { name: "pre-aborted preparation", abort: true, load: true, error: /cancelled/ },
    { name: "unsupported session loading", abort: false, load: false, error: /does not support session loading/ },
  ];
  for (const row of cases) {
    test(row.name, async (t) => {
      const connection = new MockConnection();
      connection.initialized = { protocolVersion: 1, agentCapabilities: { loadSession: row.load } };
      const controller = new AbortController();
      if (row.abort) controller.abort(new Error("cancelled"));
      const client = new AcpSessionClient({ ...options, connection, sessionId: "existing", onUpdate: () => {} });
      t.after(() => client.dispose());

      await assert.rejects(client.prepare(controller.signal), row.error);
      assert.equal(connection.requests.length, 0);
      assert.equal(connection.listeners.size, 0);
      assert.equal(connection.isRunning, false);
    });
  }
});

describe("serializeContent", () => {
  const cases: { name: string; messages: BridgeMessage[]; expected: acp.ContentBlock[] }[] = [
    { name: "omits system and empty text", messages: [{ role: "system", content: "secret" }, { role: "user", content: "" }], expected: [] },
    { name: "preserves text order and image data", messages: [{ role: "user", content: "hello" }, { role: "user", content: [{ type: "text", text: "" }, { type: "text", text: "part" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }] }], expected: [{ type: "text", text: "hello" }, { type: "text", text: "part" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }] },
  ];
  for (const row of cases) test(row.name, () => assert.deepEqual(serializeContent(row.messages), row.expected));
});

describe("RuntimeSession image payloads", () => {
  for (const row of [
    { name: "message image", hook: false, invalid: false },
    { name: "payload-hook image", hook: true, invalid: false },
    { name: "rejects missing image data", hook: true, invalid: true },
  ]) {
    test(row.name, async (t) => {
      const connection = new MockConnection();
      const runtime = new RuntimeSession(connection, options);
      t.after(() => runtime.abort());
      await runtime.prepare();
      const image = { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" };
      const submit = runtime.submit({
        model,
        messages: [{ role: "user", content: row.hook ? "image from hook" : [image] }],
        options: row.hook ? { onPayload: () => ({ sessionId: runtime.id, prompt: [row.invalid ? { type: "image", mimeType: "image/png" } : image] }) } : undefined,
        beforeInput: () => true,
      });

      if (row.invalid) {
        await assert.rejects(submit, /ACP payload supports text and image content blocks/);
        assert.equal(connection.requests.some((request) => request.method === "session/prompt"), false);
      } else {
        await submit;
        assert.deepEqual(connection.requests.find((request) => request.method === "session/prompt")?.params, {
          sessionId: "mock-session-id", prompt: [image],
        });
      }
    });
  }
});

describe("RuntimeSession notifications", () => {
  for (const outcome of ["success", "failure"] as const) {
    test(`routes live notifications and cleans up on ${outcome}`, async (t) => {
      const connection = new MockConnection();
      connection.onSession = () => connection.update("mock-session-id", "replay");
      const runtime = new RuntimeSession(connection, options);
      t.after(() => runtime.abort());
      const events: RuntimeEvent[] = [];
      runtime.onRuntimeEvent((event) => { events.push(event); });
      await runtime.prepare();
      assert.equal(events.length, 0);
      const done = new Promise<void>((resolve) => {
        runtime.onRuntimeEvent((event) => { if (event.type === "complete") resolve(); });
      });
      connection.onPrompt = async () => {
        await connection.update("other-session", "wrong");
        await connection.update("mock-session-id", "live");
        if (outcome === "failure") throw new Error("prompt failed");
        return { stopReason: "end_turn" };
      };

      await runtime.submit({ model, options: undefined, messages: [{ role: "user", content: "Test" }], beforeInput: () => true });
      await done;
      assert.deepEqual(events.filter((e) => e.type === "text-delta"), [{ type: "text-delta", delta: "live" }]);
      assert.ok(events.some((e) => e.type === "start"));
      assert.ok(events.some((e) => e.type === "session-reference" && e.reference === "mock-session-id"));
      assert.ok(events.some((e) => e.type === "complete" && e.reason === (outcome === "failure" ? "error" : "stop")));
      if (outcome !== "failure") await runtime.abort();
      assert.equal(connection.listeners.size, 0);
      const count = events.length;
      await connection.update();
      assert.equal(events.length, count);
    });
  }
});

const promptTime = Date.parse("2026-11-09T14:31:54.789Z");
const transcriptTime = "2026-11-09T14:31:54Z";
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const lastCallUsage: Usage = {
  input: 8461, output: 734, cacheRead: 0, cacheWrite: 0, totalTokens: 9195, cost: zeroCost,
};
const aggregateUsage: Usage = {
  input: 14461, output: 894, cacheRead: 0, cacheWrite: 0, totalTokens: 15355, cost: zeroCost,
};

function transcriptCall(step = 5, createdAt = transcriptTime, input = 8461, output = 734): string {
  return JSON.stringify({
    source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", step_index: step,
    created_at: createdAt, input_tokens: input, output_tokens: output, cache_read_tokens: 0,
  }) + "\n";
}

function transcriptPath(home: string, sessionId: string): string {
  return path.join(home, "antigravity-cli", "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");
}

type AccountingTurn = {
  sessionId?: string;
  before?: string;
  append?: string;
  transcriptSessionId?: string;
  context?: boolean;
  multiCall?: boolean;
  outcome?: "cancelled" | "max_tokens" | "reject";
  lastCall?: Usage;
};

const accountingCases: { name: string; standalone?: boolean; turns: AccountingTurn[] }[] = [
  {
    name: "single call attaches a seconds-precision snapshot with context notifications",
    turns: [{ append: transcriptCall(), context: true, lastCall: lastCallUsage }],
  },
  {
    name: "single call attaches a snapshot without context notifications",
    turns: [{ append: transcriptCall(), lastCall: lastCallUsage }],
  },
  {
    name: "tool and multiple calls preserve raw aggregate 15355 and attach last call 9195",
    turns: [{
      append: transcriptCall(2, transcriptTime, 6000, 160) +
        JSON.stringify({ source: "TOOL", step_index: 3 }) + "\n" + transcriptCall() +
        JSON.stringify({ source: "USER", step_index: 6 }) + "\n",
      context: true, multiCall: true, lastCall: lastCallUsage,
    }],
  },
  {
    name: "repeated prompts reject the unchanged snapshot and accept the next step",
    turns: [
      { append: transcriptCall(), lastCall: lastCallUsage, context: true },
      {},
      { append: transcriptCall(6), lastCall: lastCallUsage },
    ],
  },
  {
    name: "a fresh timestamp without an advanced step is not fresh usage",
    turns: [{ before: transcriptCall(5, "2026-11-09T14:31:53Z"), append: transcriptCall() }],
  },
  {
    name: "an advanced step with an old timestamp is not fresh usage",
    turns: [{ before: transcriptCall(4), append: transcriptCall(5, "2026-11-09T14:31:53Z") }],
  },
  {
    name: "an advanced step with a current timestamp is fresh usage",
    turns: [{ before: transcriptCall(4), append: transcriptCall(), lastCall: lastCallUsage }],
  },
  {
    name: "an advanced step after prompt completion is not fresh usage",
    turns: [{ before: transcriptCall(4), append: transcriptCall(5, "2099-01-01T00:00:00Z") }],
  },
  {
    name: "a rebuilt runtime with a new session ignores the old session transcript",
    turns: [
      { append: transcriptCall(), lastCall: lastCallUsage },
      { sessionId: "replacement-session", transcriptSessionId: "mock-session-id", append: transcriptCall(6) },
    ],
  },
  { name: "missing transcript preserves raw accounting", turns: [{}] },
  { name: "malformed transcript preserves raw accounting", turns: [{ append: "{not-json\n" }] },
  {
    name: "a malformed latest row cannot reuse an earlier snapshot",
    turns: [{ append: transcriptCall() + '{"source":"MODEL"' }],
  },
  {
    name: "standalone does not read or attach transcript snapshots",
    standalone: true,
    turns: [{ before: transcriptCall(4), append: transcriptCall() }],
  },
  {
    name: "cancelled completion preserves raw accounting without reading a final snapshot",
    turns: [{ append: transcriptCall(), outcome: "cancelled" }],
  },
  {
    name: "error stop preserves raw accounting without reading a final snapshot",
    turns: [{ append: transcriptCall(), outcome: "max_tokens" }],
  },
  {
    name: "prompt rejection emits the actual error without reading a final snapshot",
    turns: [{ append: transcriptCall(), outcome: "reject" }],
  },
];

describe("RuntimeSession transcript accounting", () => {
  for (const row of accountingCases) {
    test(row.name, async (t) => {
      const home = await mkdtemp(path.join(tmpdir(), "agy-runtime-usage-"));
      const previousHome = process.env.GEMINI_HOME;
      t.after(async () => {
        if (previousHome === undefined) delete process.env.GEMINI_HOME;
        else process.env.GEMINI_HOME = previousHome;
        await rm(home, { recursive: true, force: true });
      });
      t.mock.method(Date, "now", () => promptTime);

      const reads: string[] = [];
      const open = fs.open;
      const openMock = t.mock.method(fs, "open", (...args: Parameters<typeof open>) => {
        reads.push(String(args[0]));
        return open(...args);
      });
      syncBuiltinESMExports();
      t.after(() => {
        openMock.mock.restore();
        syncBuiltinESMExports();
      });

      let active: { runtime: RuntimeSession; connection: MockConnection } | undefined;
      for (const turn of row.turns) {
        const sessionId = turn.sessionId ?? "mock-session-id";
        if (!active || active.runtime.id !== sessionId) {
          if (active) await active.runtime.abort();
          const connection = new MockConnection();
          connection.sessionId = sessionId;
          process.env.GEMINI_HOME = home;
          const runtime = new RuntimeSession(connection, { ...options, standalone: row.standalone }, new Set(["read"]));
          // A later environment change must not redirect either transcript read.
          process.env.GEMINI_HOME = path.join(home, "not-the-runtime-home");
          t.after(() => runtime.abort());
          await runtime.prepare();
          assert.equal(runtime.id, sessionId);
          active = { runtime, connection };
        }
        const { runtime, connection } = active;
        const filename = transcriptPath(home, turn.transcriptSessionId ?? sessionId);
        await mkdir(path.dirname(filename), { recursive: true });
        if (turn.before !== undefined) await writeFile(filename, turn.before);

        const events: RuntimeEvent[] = [];
        let finish: () => void = () => {};
        const completed = new Promise<void>((resolve) => { finish = resolve; });
        const unsubscribe = runtime.onRuntimeEvent((event) => {
          events.push(event);
          if (event.type === "complete") finish();
        });
        const expectedUsage = turn.multiCall ? aggregateUsage : lastCallUsage;
        const response: PromptResponse = {
          stopReason: turn.outcome === "cancelled" || turn.outcome === "max_tokens" ? turn.outcome : "end_turn",
          usage: {
            inputTokens: expectedUsage.input, outputTokens: expectedUsage.output,
            cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: expectedUsage.totalTokens,
          },
        };
        let prompts = 0;
        connection.onPrompt = async () => {
          prompts++;
          if (turn.append !== undefined) await appendFile(filename, turn.append);
          const updates: acp.SessionNotification["update"][] = [
            { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
          ];
          if (turn.context) updates.push({ sessionUpdate: "usage_update", used: 4321, size: 100000 });
          if (turn.multiCall) updates.push({
            sessionUpdate: "tool_call", toolCallId: "read-1", title: "read", status: "completed",
            _meta: { mcp: { server: "pi-agy-bridge_pi", tool: "read" } },
          });
          for (const update of updates) {
            for (const listener of connection.listeners) await listener({ sessionId, update });
          }
          if (turn.outcome === "reject") throw new Error("accounting prompt failed");
          return response;
        };
        reads.length = 0;

        await runtime.submit({ model, options: undefined, messages: [{ role: "user", content: "Test accounting" }], beforeInput: () => true });
        await completed;
        unsubscribe();

        assert.equal(prompts, 1);
        assert.deepEqual(events.filter((event) => event.type === "text-delta"), [{ type: "text-delta", delta: "answer" }]);
        assert.equal(events.filter((event) => event.type === "start").length, 1);
        assert.equal(events.some((event) => event.type === "tool-warning"), false);
        assert.deepEqual(events.filter((event) => event.type === "usage"), turn.context ? [
          { type: "usage", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 4321, cost: zeroCost } },
          { type: "usage", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 4321, cost: zeroCost } },
        ] : []);
        assert.deepEqual(events.filter((event) => event.type === "accounting"), turn.outcome === "reject" ? [] : [{
          type: "accounting", usage: expectedUsage, ...(turn.lastCall ? { lastCallUsage: turn.lastCall } : {}),
        }]);
        const completions = events.filter((event) => event.type === "complete");
        if (turn.outcome === "reject") {
          assert.equal(completions.length, 1);
          assert.equal(completions[0]?.reason, "error");
          assert.match(completions[0]?.error ?? "", /accounting prompt failed/);
          assert.equal(completions[0]?.resumable, false);
        } else {
          assert.deepEqual(completions, [{
            type: "complete",
            reason: turn.outcome === "cancelled" ? "aborted" : turn.outcome === "max_tokens" ? "error" : "stop",
            resumable: !turn.outcome,
            ...(turn.outcome === "max_tokens" ? { error: "ACP prompt stopped: max_tokens" } : {}),
          }]);
        }
        const readCount = row.standalone ? 0 : turn.outcome ? 1 : 2;
        assert.deepEqual(reads, Array.from({ length: readCount }, () => transcriptPath(home, sessionId)));
      }
    });
  }
});
