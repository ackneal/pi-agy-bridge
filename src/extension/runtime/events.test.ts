import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { AgyResultEvent } from "../shared/types.ts";
import { AgyEventAdapter } from "./events.ts";

async function collectStreamEvents(adapter: AgyEventAdapter): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of adapter.stream) {
    events.push(ev);
  }
  return events;
}

describe("AgyEventAdapter", () => {
  const modelCases = [
    { phase: "before stream", terminal: "done", allowed: true },
    { phase: "before stream", terminal: "error", allowed: true },
    { phase: "after init", terminal: "done", allowed: false },
    { phase: "after init", terminal: "error", allowed: false },
    { phase: "after text", terminal: "done", allowed: false },
    { phase: "after text", terminal: "error", allowed: false },
    { phase: "after completion", terminal: "done", allowed: false },
    { phase: "after completion", terminal: "error", allowed: false },
  ] as const;

  for (const expected of modelCases) {
    it(`setModel ${expected.phase} ${expected.allowed ? "updates" : "preserves"} metadata through ${expected.terminal}`, async (t) => {
      const adapter = new AgyEventAdapter({ model: "original-model" });
      const finish = () => adapter.handleEvent({
        event: "result",
        status: expected.terminal === "done" ? "success" : "error",
      });
      if (expected.phase === "after init") {
        adapter.handleEvent({ event: "init" });
      }
      if (expected.phase === "after text" || expected.phase === "after completion") {
        adapter.handleEvent({ event: "step_update", delta: "Hello" });
      }
      if (expected.phase === "after completion") {
        finish();
      }
      const before = adapter.message;
      const push = t.mock.method(adapter.stream, "push");
      t.after(() => push.mock.restore());

      if (expected.allowed) {
        adapter.setModel("selected-model");
      } else {
        assert.throws(() => adapter.setModel("selected-model"), /Cannot change model after the stream has started/);
      }

      assert.equal(push.mock.callCount(), 0);
      const model = expected.allowed ? "selected-model" : "original-model";
      assert.deepEqual(adapter.message, { ...before, model });
      push.mock.restore();

      if (expected.phase === "before stream" || expected.phase === "after init") {
        adapter.handleEvent({ event: "step_update", delta: "Hello" });
      }
      if (expected.phase !== "after completion") {
        finish();
      }
      const events = await collectStreamEvents(adapter);
      assert.deepEqual(events.map((event) => event.type), [
        "start", "text_start", "text_delta", "text_end", expected.terminal,
      ]);
      for (const event of events) {
        const message = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
        assert.equal(message.model, model);
      }
      assert.equal(adapter.message.model, model);
    });
  }

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

  const quotaError = "Claude quota exceeded. Resets in 3h27m34s.";
  const resultCases: Array<{
    name: string;
    input: AgyResultEvent;
    reason: "stop" | "toolUse" | "error" | "aborted";
    errorMessage?: string;
    toolCall?: boolean;
    previousFailure?: boolean;
  }> = [
    {
      name: "lowercase success ignores a stale string error",
      input: { event: "result", status: "success", error: quotaError },
      reason: "stop",
    },
    {
      name: "nested uppercase SUCCESS ignores a stale object error",
      input: { event: "result", result: { status: "SUCCESS", error: { message: quotaError } } },
      reason: "stop",
    },
    {
      name: "uppercase SUCCESS ignores a stale flat object error",
      input: { event: "result", status: "SUCCESS", error: { message: quotaError } },
      reason: "stop",
    },
    {
      name: "nested uppercase SUCCESS ignores a stale string error",
      input: { event: "result", result: { status: "SUCCESS", error: quotaError } },
      reason: "stop",
    },
    {
      name: "mixed-case success ignores a stale object error",
      input: { event: "result", status: "SuCcEsS", error: { message: quotaError } },
      reason: "stop",
    },
    {
      name: "explicit success with a stale error preserves toolUse",
      input: { event: "result", status: "SUCCESS", error: quotaError },
      reason: "toolUse",
      toolCall: true,
    },
    {
      name: "lowercase error reports an object error after text output",
      input: { event: "result", status: "error", error: { message: quotaError } },
      reason: "error",
      errorMessage: quotaError,
    },
    {
      name: "nested uppercase ERROR reports a string error after text output",
      input: { event: "result", result: { status: "ERROR", error: quotaError } },
      reason: "error",
      errorMessage: quotaError,
    },
    {
      name: "mixed-case error without diagnostics uses the default error",
      input: { event: "result", status: "ErRoR" },
      reason: "error",
      errorMessage: "agy execution reported error status",
    },
    {
      name: "omitted status with a string error still fails",
      input: { event: "result", error: quotaError },
      reason: "error",
      errorMessage: quotaError,
    },
    {
      name: "omitted status with an object error still fails",
      input: { event: "result", result: { error: { message: quotaError } } },
      reason: "error",
      errorMessage: quotaError,
    },
    {
      name: "unknown status with a string error still fails",
      input: { event: "result", status: "UNKNOWN", error: quotaError },
      reason: "error",
      errorMessage: quotaError,
    },
    {
      name: "unknown status with an object error still fails",
      input: { event: "result", status: "unknown", error: { message: quotaError } },
      reason: "error",
      errorMessage: quotaError,
    },
    {
      name: "omitted status with an empty error object uses the default error",
      input: { event: "result", error: {} },
      reason: "error",
      errorMessage: "agy execution reported error status",
    },
    {
      name: "unknown status with an empty error object uses the default error",
      input: { event: "result", status: "unknown", error: {} },
      reason: "error",
      errorMessage: "agy execution reported error status",
    },
    {
      name: "omitted status without an error still succeeds",
      input: { event: "result" },
      reason: "stop",
    },
    {
      name: "unknown status without an error still succeeds",
      input: { event: "result", status: "UNKNOWN" },
      reason: "stop",
    },
    {
      name: "lowercase aborted without diagnostics remains aborted",
      input: { event: "result", status: "aborted" },
      reason: "aborted",
    },
    {
      name: "uppercase ABORTED without diagnostics remains aborted",
      input: { event: "result", result: { status: "ABORTED" } },
      reason: "aborted",
    },
    {
      name: "lowercase aborted retains a string diagnostic without becoming error",
      input: { event: "result", status: "aborted", error: "Cancelled by user" },
      reason: "aborted",
      errorMessage: "Cancelled by user",
    },
    {
      name: "uppercase ABORTED retains an object diagnostic without becoming error",
      input: { event: "result", result: { status: "ABORTED", error: { message: "Cancelled by user" } } },
      reason: "aborted",
      errorMessage: "Cancelled by user",
    },
    {
      name: "fresh adapter carries no previous error into a clean success",
      input: { event: "result", status: "success" },
      reason: "stop",
      previousFailure: true,
    },
    {
      name: "fresh adapter carries no previous error into SUCCESS with the same stale quota error",
      input: { event: "result", result: { status: "SUCCESS", error: { message: quotaError } } },
      reason: "stop",
      previousFailure: true,
    },
  ];

  for (const expected of resultCases) {
    it(expected.name, async () => {
      const previous = expected.previousFailure
        ? new AgyEventAdapter({ model: "claude-sonnet-4-6" })
        : undefined;
      if (previous) {
        previous.handleEvent({ event: "result", status: "ERROR", error: quotaError });
        const previousEvents = await collectStreamEvents(previous);
        const error = previousEvents.find((event) => event.type === "error");
        assert.ok(error);
        assert.equal(error.error.errorMessage, quotaError);
      }

      const adapter = new AgyEventAdapter({ model: "gemini-3.8-flash-high" });
      const text = "Hello! How can I help you today?";
      if (previous) {
        assert.equal(adapter.isCompleted(), false);
        assert.equal(Object.hasOwn(adapter.message, "errorMessage"), false);
        assert.deepEqual(adapter.message.content, []);
      }
      adapter.handleEvent({ event: "step_update", delta: text });
      if (expected.toolCall) {
        adapter.handleEvent({
          event: "step_update",
          tool_call: { id: "call-1", name: "mcp__pi__read", arguments: { path: "README.md" } },
        });
      }

      adapter.handleEvent(expected.input);

      const events = await collectStreamEvents(adapter);
      const terminalEvents = events.filter((event) => event.type === "done" || event.type === "error");
      assert.equal(terminalEvents.length, 1);
      const terminal = terminalEvents[0];
      assert.ok(terminal);
      assert.equal(terminal.type, expected.reason === "error" || expected.reason === "aborted" ? "error" : "done");
      assert.equal(terminal.reason, expected.reason);
      const message = terminal.type === "done" ? terminal.message : terminal.error;
      assert.equal(message.stopReason, expected.reason);
      assert.equal(message.errorMessage, expected.errorMessage);
      assert.deepEqual(message.content[0], { type: "text", text });
      assert.equal(events.filter((event) => event.type === "text_end").length, 1);
      if (expected.toolCall) {
        assert.deepEqual(message.content[1], {
          type: "toolCall", id: "call-1", name: "mcp__pi__read", arguments: { path: "README.md" },
        });
      }
      if (previous) {
        for (const event of events) {
          const snapshot = event.type === "done" ? event.message : "partial" in event ? event.partial : undefined;
          assert.ok(snapshot);
          assert.equal(Object.hasOwn(snapshot, "errorMessage"), false);
          assert.equal(snapshot.model, "gemini-3.8-flash-high");
        }
        assert.equal(Object.hasOwn(adapter.message, "errorMessage"), false);
        assert.equal(previous.message.errorMessage, quotaError);
      }
    });
  }

  const completedCases: Array<{ name: string; input: AgyResultEvent; type: "done" | "error" }> = [
    { name: "successful stream ignores late events without changing its message", input: { event: "result", status: "SUCCESS" }, type: "done" },
    { name: "failed stream ignores late events without changing its message", input: { event: "result", status: "ERROR", error: quotaError }, type: "error" },
  ];

  for (const expected of completedCases) {
    it(expected.name, async (t) => {
      const adapter = new AgyEventAdapter({ model: "gemini-3.8-flash-high" });
      adapter.handleEvent({ event: "step_update", delta: "Completed text" });
      adapter.handleEvent(expected.input);
      const events = await collectStreamEvents(adapter);
      const terminal = events.find((event) => event.type === "done" || event.type === "error");
      assert.ok(terminal);
      assert.equal(terminal.type, expected.type);
      assert.equal(adapter.isCompleted(), true);
      const message = structuredClone(adapter.message);
      const push = t.mock.method(adapter.stream, "push");
      t.after(() => push.mock.restore());

      adapter.handleEvent(expected.input);
      adapter.handleEvent({ event: "init", conversation_id: "late-conversation" });
      adapter.handleEvent({ event: "step_update", delta: "late text", usage: { input_tokens: 999 } });
      adapter.handleEvent({ event: "result", status: "error", error: "late error" });
      adapter.handleEvent({ event: "result", status: "success" });

      assert.equal(push.mock.callCount(), 0);
      assert.deepEqual(adapter.message, message);
    });
  }

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

  it("allows Antigravity CLI internal dispatchers without exposing them as Pi tool calls", () => {
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

  it("blocks native executable Antigravity CLI tool calls when a Pi tool allowlist is active", async () => {
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
    assert.equal(error.error.errorMessage, "The model attempted to call an unavailable tool: run_command");
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
