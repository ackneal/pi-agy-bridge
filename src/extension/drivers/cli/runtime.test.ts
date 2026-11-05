import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import type { Model } from "@earendil-works/pi-ai";
import { AcpSessionClient, RuntimeSession, serializeContent, type RuntimeConnection } from "./runtime.ts";
import type { BridgeMessage, RuntimeEvent } from "../types.ts";

function option(id: string, value: string): Extract<acp.SessionConfigOption, { type: "select" }> {
  return { id, name: id, type: "select", currentValue: "default", options: [{ name: value, value }] };
}

class MockConnection implements RuntimeConnection {
  isRunning = true;
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
      return { sessionId: "mock-session-id", configOptions: this.configOptions };
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
          cwd: options.cwd, mcpServers: [], _meta: { antigravity: { enabledTools: standalone ? [] : ["view_file"], systemPrompt: { append: "instructions" } } },
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
