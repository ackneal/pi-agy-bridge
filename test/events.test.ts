import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { AgyEventAdapter } from "../src/events.ts";

async function collectStreamEvents(adapter: AgyEventAdapter): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of adapter.stream) {
    events.push(ev);
  }
  return events;
}

describe("AgyEventAdapter", () => {
  it("maps init event to responseId on the start event", async () => {
    const adapter = new AgyEventAdapter({ model: "gemini-3.8-flash-high" });
    const events = adapter.stream[Symbol.asyncIterator]();

    adapter.handleEvent({
      event: "init",
      conversation_id: "conv-12345",
      model: "gemini-3.8-flash-high",
    });

    const first = await events.next();
    assert.equal(first.done, false);
    assert.equal(first.value?.type, "start");
    assert.equal(first.value?.partial.responseId, "conv-12345");
    await events.return?.();
  });

  it("maps streaming text deltas to text_start, text_delta, text_end and done", async () => {
    const adapter = new AgyEventAdapter({ model: "gemini-3.8-flash-high" });

    adapter.handleEvent({ event: "init" });
    adapter.handleEvent({ event: "step_update", delta: "Hello" });
    adapter.handleEvent({ event: "step_update", delta: ", " });
    adapter.handleEvent({ event: "step_update", delta: "world!" });
    adapter.handleEvent({
      event: "result",
      status: "success",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const events = await collectStreamEvents(adapter);
    const types = events.map((e) => e.type);

    assert.equal(types[0], "start");
    assert.equal(types.includes("text_start"), true);
    assert.equal(types.filter((t) => t === "text_delta").length, 3);
    assert.equal(types.includes("text_end"), true);
    assert.equal(types[types.length - 1], "done");

    const doneEvent = events.find((e) => e.type === "done") as any;
    const msg = doneEvent.message;
    assert.equal(msg.content.length, 1);
    assert.equal(msg.content[0]?.type, "text");
    assert.equal((msg.content[0] as any)?.text, "Hello, world!");
    assert.equal(msg.stopReason, "stop");
  });

  it("maps the nested agy stream-json event envelope", async () => {
    const adapter = new AgyEventAdapter({ model: "gemini-3.8-flash-high" });

    adapter.handleEvent({
      event: "step_update",
      step_update: {
        conversation_id: "conv-real",
        step_index: 1,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "actual transcript",
      },
    });
    adapter.handleEvent({
      event: "result",
      result: {
        conversation_id: "conv-real",
        status: "SUCCESS",
        response: "actual transcript",
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
      },
    });

    const events = await collectStreamEvents(adapter);
    assert.equal(events.some((e) => e.type === "text_delta" && (e as any).delta === "actual transcript"), true);

    const doneEvent = events.find((e) => e.type === "done") as any;
    assert.equal(doneEvent.message.content[0]?.text, "actual transcript");
    assert.equal(doneEvent.message.responseId, "conv-real");
    assert.equal(doneEvent.message.usage.totalTokens, 15);
  });

  it("maps nested delta object in step_update", async () => {
    const adapter = new AgyEventAdapter({ model: "gemini-3.8-flash-high" });

    adapter.handleEvent({
      event: "step_update",
      delta: { text: "from nested object" },
    });
    adapter.handleEvent({ event: "result", status: "success" });

    const events = await collectStreamEvents(adapter);
    assert.equal(events.some((e) => e.type === "text_delta" && (e as any).delta === "from nested object"), true);

    const doneEvent = events.find((e) => e.type === "done") as any;
    const msg = doneEvent.message;
    assert.equal(msg.content[0]?.type, "text");
    assert.equal((msg.content[0] as any)?.text, "from nested object");
  });

  it("maps tool_call in step_update to toolcall_start, delta, end and reason 'toolUse'", async () => {
    const adapter = new AgyEventAdapter({ model: "claude-sonnet-4-6" });

    adapter.handleEvent({
      event: "step_update",
      tool_call: {
        id: "call_abc123",
        name: "mcp__pi__read_file",
        arguments: JSON.stringify({ path: "README.md" }),
      },
    });

    adapter.handleEvent({
      event: "result",
      status: "success",
      usage: { input_tokens: 20, output_tokens: 15 },
    });

    const events = await collectStreamEvents(adapter);
    const types = events.map((e) => e.type);

    assert.equal(types.includes("toolcall_start"), true);
    assert.equal(types.includes("toolcall_delta"), true);
    assert.equal(types.includes("toolcall_end"), true);
    assert.equal(types.includes("done"), true);

    const doneEvent = events.find((e) => e.type === "done") as any;
    const msg = doneEvent.message;
    assert.equal(msg.stopReason, "toolUse");
    assert.equal(msg.content.length, 1);
    const tc = msg.content[0] as any;
    assert.equal(tc.type, "toolCall");
    assert.equal(tc.id, "call_abc123");
    assert.equal(tc.name, "mcp__pi__read_file");
    assert.deepEqual(tc.arguments, { path: "README.md" });
  });

  it("maps step_update with type 'tool' to tool call", async () => {
    const adapter = new AgyEventAdapter({ model: "gemini-3.8-flash-high" });

    adapter.handleEvent({
      event: "step_update",
      type: "tool",
      name: "mcp__pi__bash",
      call_id: "bash_1",
      input: { command: "ls -la" },
    });
    adapter.handleEvent({ event: "result", status: "success" });

    const events = await collectStreamEvents(adapter);
    assert.equal(events.some((e) => e.type === "toolcall_end"), true);

    const doneEvent = events.find((e) => e.type === "done") as any;
    const msg = doneEvent.message;
    assert.equal(msg.stopReason, "toolUse");
    const tc = msg.content[0] as any;
    assert.equal(tc.type, "toolCall");
    assert.equal(tc.id, "bash_1");
    assert.equal(tc.name, "mcp__pi__bash");
    assert.deepEqual(tc.arguments, { command: "ls -la" });
  });

  it("maps result error statuses to error events", async () => {
    const cases = [
      {
        input: { event: "result", status: "error", error: { message: "Quota exceeded" } },
        reason: "error",
        message: "Quota exceeded",
      },
      { input: { event: "result", status: "aborted" }, reason: "aborted" },
    ] as const;

    for (const expected of cases) {
      const adapter = new AgyEventAdapter({ model: "gemini-3.8-flash-high" });
      adapter.handleEvent(expected.input);

      const events = await collectStreamEvents(adapter);
      const errorEvent = events.find((event) => event.type === "error") as any;
      assert.ok(errorEvent);
      assert.equal(errorEvent.reason, expected.reason);
      assert.equal(errorEvent.error.stopReason, expected.reason);
      if (expected.message) assert.equal(errorEvent.error.errorMessage, expected.message);
    }
  });

  it("handleTermination handles process termination with reason aborted and closes active text", async () => {
    const adapter = new AgyEventAdapter({ model: "gemini-3.8-flash-high" });

    adapter.handleEvent({ event: "step_update", delta: "Unfinished response..." });
    adapter.handleTermination("aborted", "Child process was terminated");

    assert.equal(adapter.isCompleted(), true);
    const events = await collectStreamEvents(adapter);
    assert.equal(events.some((e) => e.type === "text_end"), true);
    assert.equal(events.some((e) => e.type === "error" && (e as any).reason === "aborted"), true);
    const errorEvent = events.find((e) => e.type === "error") as any;
    assert.equal(errorEvent.error.stopReason, "aborted");
    assert.equal(errorEvent.error.errorMessage, "Child process was terminated");
  });

  it("allows AGY internal dispatchers without exposing them as Pi tool calls", () => {
    for (const internalTool of ["manage_task", "call_mcp_tool"]) {
      const adapter = new AgyEventAdapter({
        model: "gemini-3.8-flash-high",
        allowedToolNames: new Set(["read"]),
        bridgeToolCallsExternally: true,
      });

      adapter.handleEvent({
        event: "step_update",
        type: "tool",
        name: internalTool,
        call_id: "native-1",
        input: {},
      });

      assert.equal(adapter.isCompleted(), false);
      assert.deepEqual(adapter.message.content, []);
    }
  });

  it("blocks native executable AGY tool calls when a Pi tool allowlist is active", async () => {
    const adapter = new AgyEventAdapter({
      model: "gemini-3.8-flash-high",
      allowedToolNames: new Set(["read"]),
      bridgeToolCallsExternally: true,
    });

    adapter.handleEvent({
      event: "step_update",
      type: "tool",
      name: "run_command",
      call_id: "native-2",
      input: {},
    });

    const events = await collectStreamEvents(adapter);
    const error = events.find((event) => event.type === "error") as any;
    assert.equal(error.error.errorMessage, "AgY attempted to call an unavailable tool: run_command");
  });

  it("emits Pi-native tool names for calls relayed through MCP", async () => {
    const adapter = new AgyEventAdapter({
      model: "gemini-3.8-flash-high",
      allowedToolNames: new Set(["read"]),
      bridgeToolCallsExternally: true,
    });

    adapter.handleBridgeToolCalls([{
      type: "toolCall",
      id: "pi-1",
      name: "read",
      arguments: { path: "README.md" },
    }]);

    const events = await collectStreamEvents(adapter);
    const done = events.find((event) => event.type === "done") as any;
    assert.equal(done.reason, "toolUse");
    assert.equal(done.message.content[0].name, "read");
  });

  it("accumulates step usage while preserving the latest context and final cache statistics", async () => {
    const adapter = new AgyEventAdapter({ model: "gemini-3.8-flash-high" });
    adapter.handleEvent({
      event: "step_update",
      step_type: "agent_response",
      usage: { input_tokens: 40, output_tokens: 2, thinking_tokens: 1, total_tokens: 42 },
    });
    adapter.handleEvent({
      event: "step_update",
      step_type: "agent_response",
      usage: { input_tokens: 50, output_tokens: 3, thinking_tokens: 2, total_tokens: 53 },
    });

    assert.equal(adapter.message.usage.input, 50);
    assert.equal(adapter.message.usage.totalTokens, 53);

    adapter.handleEvent({
      event: "result",
      status: "success",
      usage: {
        input_tokens: 50,
        output_tokens: 3,
        thinking_tokens: 2,
        cache_read_tokens: 20,
        total_tokens: 73,
      },
    });

    const events = await collectStreamEvents(adapter);
    const doneEvent = events.find((event) => event.type === "done");
    assert.equal(doneEvent?.type, "done");
    if (doneEvent?.type !== "done") return;
    assert.equal(doneEvent.message.usage.input, 50);
    assert.equal(doneEvent.message.usage.output, 3);
    assert.equal(doneEvent.message.usage.reasoning, 2);
    assert.equal(doneEvent.message.usage.cacheRead, 0);
    assert.equal(doneEvent.message.usage.totalTokens, 53);
  });

  it("ignores session-cumulative result usage and keeps the last step snapshot", async () => {
    const adapter = new AgyEventAdapter({ model: "gemini-3.8-flash" });
    adapter.handleEvent({
      event: "step_update",
      step_type: "agent_response",
      usage: { input_tokens: 7741, output_tokens: 1284, thinking_tokens: 610, cache_read_tokens: 0, total_tokens: 9025 },
    });
    adapter.handleEvent({
      event: "result",
      status: "SUCCESS",
      usage: {
        input_tokens: 52512,
        output_tokens: 2879,
        thinking_tokens: 1392,
        cache_read_tokens: 329718,
        total_tokens: 55391,
      },
    });

    const events = await collectStreamEvents(adapter);
    const doneEvent = events.find((e) => e.type === "done") as any;
    assert.equal(doneEvent.reason, "stop");
    assert.equal(doneEvent.message.usage.input, 7741);
    assert.equal(doneEvent.message.usage.cacheRead, 0);
    assert.equal(doneEvent.message.usage.totalTokens, 9025);
  });

  it("applies zero-cost subscription semantics to usage", async () => {
    const adapter = new AgyEventAdapter({ model: "gemini-3.8-flash-high" });
    adapter.handleEvent({
      event: "result",
      status: "success",
      usage: {
        input_tokens: 1500,
        output_tokens: 300,
        cache_read_tokens: 400,
        thinking_tokens: 120,
        total_tokens: 1800,
      },
    });

    const events = await collectStreamEvents(adapter);
    const doneEvent = events.find((e) => e.type === "done") as any;
    const msg = doneEvent.message;
    assert.equal(msg.usage.input, 1500);
    assert.equal(msg.usage.output, 300);
    assert.equal(msg.usage.cacheRead, 400);
    assert.equal(msg.usage.reasoning, 120);
    assert.equal(msg.usage.totalTokens, 2200);
    assert.deepEqual(msg.usage.cost, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    });
  });
});
