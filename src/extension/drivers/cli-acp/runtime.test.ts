import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AcpSessionClient, RuntimeSession, serializeContent } from "./runtime.ts";
import type { BridgeMessage, RuntimeEvent } from "../types.ts";

function createMockConnection(handlers?: {
  onRequest?: (method: string, params: any) => Promise<any>;
  onNotify?: (method: string, params: any) => Promise<void>;
}) {
  const requests: { method: string; params: any }[] = [];
  const notifications: { method: string; params: any }[] = [];
  let isRunning = true;

  return {
    requests,
    notifications,
    get isRunning() {
      return isRunning;
    },
    async start() {
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          _meta: { antigravity: { systemPrompt: { append: true } } },
        },
      };
    },
    async request(method: string, params: any) {
      requests.push({ method, params });
      if (handlers?.onRequest) return handlers.onRequest(method, params);

      if (method === "session/new") {
        return {
          sessionId: "mock-session-id",
          configOptions: [
            { id: "model", type: "select", options: [{ value: "gemini-3.8-flash" }] },
            { id: "thought_level", type: "select", options: [{ value: "high" }] },
          ],
        };
      }
      if (method === "session/set_config_option" || method === "session/setConfigOption") {
        return {
          configOptions: [
            { id: "model", type: "select", currentValue: params.value, options: [{ value: "gemini-3.8-flash" }] },
            { id: "thought_level", type: "select", currentValue: params.value, options: [{ value: "high" }] },
          ],
        };
      }
      if (method === "session/prompt") {
        return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
      }
      return {};
    },
    async notify(method: string, params: any) {
      notifications.push({ method, params });
      if (handlers?.onNotify) await handlers.onNotify(method, params);
    },
    async dispose() {
      isRunning = false;
    },
  } as any;
}

describe("serializeContent", () => {
  test("serializes text messages and ignores system messages", () => {
    const messages: BridgeMessage[] = [
      { role: "system", content: "ignore system" },
      { role: "user", content: "hello user" },
      { role: "user", content: [{ type: "text", text: "part text" }] },
    ];
    const blocks = serializeContent(messages);
    assert.deepEqual(blocks, [
      { type: "text", text: "hello user" },
      { type: "text", text: "part text" },
    ]);
  });
});

describe("AcpSessionClient", () => {
  test("prepare initializes session and sets config options using snake_case RPC", async () => {
    const connection = createMockConnection();
    const client = new AcpSessionClient({
      connection,
      cwd: "/mock/cwd",
      model: "gemini-3.8-flash",
      effort: "high",
      systemPrompt: "Mock instructions",
      onUpdate: () => {},
    });

    await client.prepare();

    assert.equal(client.id, "mock-session-id");
    assert.ok(client.isRunning);

    // Verify session/new was called with append systemPrompt and enabledTools: ["view_file"] in primary mode
    const newSession = connection.requests.find((r: any) => r.method === "session/new");
    assert.ok(newSession);
    assert.equal(newSession.params._meta.antigravity.systemPrompt.append, "Mock instructions");
    assert.deepEqual(newSession.params._meta.antigravity.enabledTools, ["view_file"]);

    // Verify session/set_config_option was called for model and thought_level
    const configCalls = connection.requests.filter((r: any) => r.method === "session/set_config_option");
    assert.equal(configCalls.length, 2);
    assert.deepEqual(configCalls[0]?.params, { sessionId: "mock-session-id", configId: "model", value: "gemini-3.8-flash" });
    assert.deepEqual(configCalls[1]?.params, { sessionId: "mock-session-id", configId: "thought_level", value: "high" });
  });

  test("prepare falls back to session/setConfigOption if session/set_config_option returns method not found", async () => {
    const connection = createMockConnection({
      onRequest: async (method, params) => {
        if (method === "session/new") {
          return {
            sessionId: "legacy-session-id",
            configOptions: [{ id: "model", type: "select", options: [{ value: "gemini-3.8-flash" }] }],
          };
        }
        if (method === "session/set_config_option") {
          throw new Error("Method not found: -32601");
        }
        if (method === "session/setConfigOption") {
          return { configOptions: [{ id: "model", type: "select", currentValue: params.value, options: [{ value: "gemini-3.8-flash" }] }] };
        }
        return {};
      },
    });

    const client = new AcpSessionClient({
      connection,
      cwd: "/mock/cwd",
      model: "gemini-3.8-flash",
      onUpdate: () => {},
    });

    await client.prepare();

    const camelCall = connection.requests.find((r: any) => r.method === "session/setConfigOption");
    assert.ok(camelCall);
    assert.equal(camelCall.params.configId, "model");
  });

  test("prompt and cancel lifecycle", async () => {
    const connection = createMockConnection();
    const client = new AcpSessionClient({
      connection,
      cwd: "/mock/cwd",
      model: "gemini-3.8-flash",
      onUpdate: () => {},
    });

    await client.prepare();

    const response = await client.prompt([{ type: "text", text: "Say hello" }]);
    assert.equal(response.stopReason, "end_turn");

    await client.cancel();
    assert.ok(connection.notifications.some((n: any) => n.method === "session/cancel"));
    assert.ok(!client.isRunning);
  });

  test("prepare sends enabledTools: [] only when standalone is true", async () => {
    const connection = createMockConnection();
    const client = new AcpSessionClient({
      connection,
      cwd: "/mock/cwd",
      model: "gemini-3.8-flash",
      standalone: true,
      onUpdate: () => {},
    });

    await client.prepare();

    const newSession = connection.requests.find((r: any) => r.method === "session/new");
    assert.ok(newSession);
    assert.deepEqual(newSession.params._meta.antigravity.enabledTools, []);
  });
});

describe("RuntimeSession", () => {
  test("submit dispatches prompt and emits events", async () => {
    const connection = createMockConnection();
    const runtime = new RuntimeSession(
      connection,
      {
        cwd: "/mock/cwd",
        model: "gemini-3.8-flash",
      },
      new Set(["read"]),
      "compat-key"
    );

    await runtime.prepare();

    const events: RuntimeEvent[] = [];
    runtime.onRuntimeEvent((e) => events.push(e));

    await runtime.submit({
      model: { id: "gemini-3.8-flash" } as any,
      options: undefined,
      messages: [{ role: "user", content: "Test message" }],
      beforeInput: () => true,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.ok(events.some((e) => e.type === "start"));
    assert.ok(events.some((e) => e.type === "session-reference" && e.reference === "mock-session-id"));
    assert.ok(events.some((e) => e.type === "complete" && e.reason === "stop"));
  });
});
