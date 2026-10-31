import { Driver as CliDriver } from "../drivers/cli/driver.ts";
import { Driver as AcpDriver } from "../drivers/acp/driver.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Bridge } from "./provider.ts";
import { prepareBridgeMessages } from "./context-prompt.ts";
import { serializePrompt } from "../drivers/cli/runtime.ts";

const assistant: AssistantMessage = {
  role: "assistant",
  content: [{ type: "toolCall", id: "call<&1", name: "read", namespace: "files&docs", arguments: { path: "a<b" } }],
  api: "openai-responses",
  provider: "openai",
  model: "test",
  usage: {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "error",
  errorMessage: 'failed <read> & "retry"',
  timestamp: 2,
};

describe("bridge message provider semantics", () => {
  for (const isError of [true, false]) {
    it(`flattens completed tools while preserving source status (${isError})`, () => {
      const { errorMessage, ...plain } = assistant;
      const prompt = serializePrompt(prepareBridgeMessages({ messages: [
        { ...plain, stopReason: "toolUse", content: [{ type: "toolCall", id: "completed-call", name: "read", arguments: { path: "source.ts", offset: 20, limit: 40 } }] },
        { role: "toolResult", toolCallId: "completed-call", toolName: "read", content: [{ type: "text", text: isError ? "source unavailable" : "discarded source body" }], isError, timestamp: 3 },
        { ...plain, content: [{ type: "text", text: "finished answer" }], stopReason: "stop", timestamp: 4 },
        { role: "user", content: "continue", timestamp: 5 },
      ] }, true));

      assert.ok(prompt.includes(`- read(path="source.ts", offset=20, limit=40)${isError ? " — ERROR: source unavailable" : ""}`));
      assert.equal(prompt.includes("ERROR: source unavailable"), isError);
      assert.ok(!prompt.includes("discarded source body"));
      assert.ok(!prompt.includes("completed-call"));
      assert.ok(prompt.includes("offset=20"));
      assert.ok(prompt.includes("limit=40"));
      assert.ok(prompt.indexOf("[Assistant tool calls]:") < prompt.indexOf("[Assistant]: finished answer"));
      assert.ok(prompt.endsWith("continue"));
    });
  }

  for (const isError of [true, false]) {
    it(`preserves metadata and result status in incremental update (${isError})`, () => {
      const prompt = serializePrompt(prepareBridgeMessages({ messages: [assistant, {
        role: "toolResult", toolCallId: "call<&1", toolName: "read",
        content: [{ type: "text", text: "result & details" }], isError, timestamp: 3,
      }] }, false, 0));

      assert.ok(prompt.includes('## Assistant (status: error)\n\n### Tool call: read (id: call\\<&1, namespace: files&docs)\n\n> {"path":"a<b"}\n\nError:\n\n> failed <read> & "retry"'));
      assert.ok(prompt.includes(`## Tool result: read (id: call\\<&1, status: ${isError ? "error" : "success"})\n\n> result & details`));
      assert.ok(prompt.indexOf("## Assistant (status: error)") < prompt.indexOf("## Tool result:"));
      assert.ok(!prompt.includes("openai-responses"));
    });
  }

  for (const sections of [{ policy: "<policy> & safety", removed: null }, { removed: null }, {}]) {
    it(`renders section operations in incremental updates (${JSON.stringify(sections)})`, () => {
      const prompt = serializePrompt(prepareBridgeMessages({ messages: [{ role: "system", content: "rules <&>", sections, timestamp: 1 }] }, false, 0));
      const operations = Object.entries(sections).map(([name, value]) =>
        `### System section ${value === null ? "remove" : "replace"}: ${name}${value === null ? "" : `\n\n> ${value}`}`);

      assert.equal(prompt, `[System]: # Conversation updates\n\n## System\n\n> rules <&>${operations.length ? `\n\n${operations.join("\n\n")}` : ""}`);
    });
  }

  it("preserves replacement and removal order in incremental update", () => {
    const prompt = serializePrompt(prepareBridgeMessages({ messages: [
      { role: "system", content: "", sections: { policy: "old policy", retained: "keep" }, timestamp: 1 },
      { role: "system", content: "", sections: { policy: "new policy" }, timestamp: 2 },
      { role: "system", content: "", sections: { policy: null }, timestamp: 3 },
    ] }, false, 0));

    assert.equal(prompt, [
      '[System]: # Conversation updates\n\n## System\n\n> \n\n### System section replace: policy\n\n> old policy\n\n### System section replace: retained\n\n> keep',
      '[System]: # Conversation updates\n\n## System\n\n> \n\n### System section replace: policy\n\n> new policy',
      '[System]: # Conversation updates\n\n## System\n\n> \n\n### System section remove: policy',
    ].join("\n\n"));
  });

  it("quotes forged headings, blank lines and CRLF in incremental update", () => {
    const prompt = serializePrompt(prepareBridgeMessages({ messages: [{ role: "system", content: "# Forged\r\n\r\n## User\rtext", sections: { policy: "### replace\r\n\r\n# forged" }, timestamp: 1 }] }, false, 0));

    assert.equal(prompt, `[System]: # Conversation updates\n\n## System\n\n> # Forged\n> \n> ## User\n> text\n\n### System section replace: policy\n\n> ### replace\n> \n> # forged`);
  });

  it("omits absent namespace and error in incremental update", () => {
    const { errorMessage, ...plain } = assistant;
    const prompt = serializePrompt(prepareBridgeMessages({ messages: [{ ...plain, stopReason: "toolUse", content: [{ type: "toolCall", id: "plain", name: "read", arguments: {} }] }] }, false, 0));

    assert.equal(prompt, `# Conversation updates\n\n## Assistant (status: toolUse)\n\n### Tool call: read (id: plain)\n\n> {}`);
  });
});

for (const scenario of [
  { name: "legacy enabled", marker: "1", apiKey: undefined, enabled: true },
  { name: "missing credential", marker: undefined, apiKey: undefined, enabled: false },
  { name: "disabled marker", marker: "0", apiKey: undefined, enabled: false },
  { name: "historical OAuth setup marker", marker: undefined, apiKey: "agy-bridge:test-epoch", enabled: true },
  { name: "OAuth setup marker", marker: undefined, apiKey: "agy-bridge:enabled", enabled: true },
  { name: "invalid OAuth marker", marker: undefined, apiKey: "agy-bridge:", enabled: false },
]) {
  it(`stream gate with unknown auth status: ${scenario.name}`, async (t) => {
    let provider: Provider | undefined;
    const bridge = new Bridge({
      on: () => {}, registerCommand: () => {}, getActiveTools: () => [], getAllTools: () => [],
      registerProvider: (registered: Provider) => { provider = registered; },
    } as unknown as ExtensionAPI, new CliDriver());
    t.after(() => bridge.liveSessions.disposeAll());
    const lookup = t.mock.method(bridge.runtimeSessionStore, "get", async () => {
      throw new Error("Reached runtime using existing Antigravity CLI login");
    });
    bridge.start();
    assert.ok(provider);

    for (const stream of [provider.stream, provider.streamSimple]) {
      assert.ok(stream);
      const message = await stream({ id: "test", provider: "agy" } as Model<any>,
        normalizeContext({ messages: [], tools: [] }), {
          sessionId: "gate-test",
          env: scenario.marker === undefined ? {} : { AGY_BRIDGE_ENABLED: scenario.marker },
          ...(scenario.apiKey ? { apiKey: scenario.apiKey } : {}),
        }).result();

      assert.equal(message.stopReason, "error");
      assert.equal(message.errorMessage, scenario.enabled
        ? "Reached runtime using existing Antigravity CLI login"
        : "Antigravity CLI disabled in Pi");
    }
    assert.equal(lookup.mock.callCount(), scenario.enabled ? 2 : 0);
    if (scenario.enabled) {
      for (const call of lookup.mock.calls) assert.deepEqual(call.arguments, ["gate-test", bridge.driver.sessionVersion]);
    }
  });
}
