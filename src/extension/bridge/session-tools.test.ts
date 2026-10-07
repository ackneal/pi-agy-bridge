import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { describe, it } from "node:test";
import { Type } from "typebox";
import type { Message, Tool } from "@earendil-works/pi-ai";
import {
  AGY_MCP_PREFIX,
  fromMcpToolName,
  translateToolSchema,
  piToolToMcpTool,
  CapabilityGateway,
  PiToolAdapter,
  isAllowedPiToolName,
} from "./capabilities.ts";
import { SessionResources } from "../session/session.ts";

const ptyTool: Tool = {
  name: "pty",
  description: "Manage terminals",
  parameters: Type.Object({
    command: Type.String(),
    ptyId: Type.Optional(Type.String()),
  }),
};

describe("Tool naming helpers", () => {
  const fromMcpCases = [
    { input: `${AGY_MCP_PREFIX}bash`, expected: "bash" },
    { input: "bash", expected: "bash" },
    { input: "other_tool", expected: "other_tool" },
  ];

  it("converts prefixed names and leaves ordinary names unchanged", () => {
    for (const tc of fromMcpCases) assert.equal(fromMcpToolName(tc.input), tc.expected);
  });
});

describe("translateToolSchema and piToolToMcpTool", () => {
  it("translateToolSchema converts TypeBox schemas into valid MCP JSON Schema", () => {
    const typeboxSchema = Type.Object({
      path: Type.String({ description: "Path to file" }),
      count: Type.Optional(Type.Number()),
    }, {
      minProperties: 1,
      $defs: { label: { type: "string" } },
    });

    const translated = translateToolSchema(typeboxSchema);
    assert.equal(translated.type, "object");
    assert.ok(translated.properties);
    assert.equal((translated.properties as any).path?.type, "string");
    assert.equal((translated.properties as any).path?.description, "Path to file");
    assert.equal((translated.properties as any).count?.type, "number");
    assert.deepEqual(translated.required, ["path"]);
    assert.equal(translated.minProperties, 1);
    assert.deepEqual(translated.$defs, { label: { type: "string" } });
  });

  it("translateToolSchema falls back for absent and non-object root schemas", () => {
    for (const input of [undefined, null as any, { anyOf: [{ type: "string" }, { type: "number" }] }]) {
      assert.deepEqual(translateToolSchema(input), { type: "object", properties: {} });
    }
  });

  it("piToolToMcpTool transforms a Pi Tool into an McpToolDefinition", () => {
    const tool: Tool = {
      name: "run_build",
      description: "Build the project",
      parameters: Type.Object({
        target: Type.String(),
      }),
    };

    const mcpDef = piToolToMcpTool(tool);
    assert.equal(mcpDef.name, "run_build");
    assert.equal(mcpDef.description, "Build the project");
    assert.equal(mcpDef.inputSchema.type, "object");
    assert.ok(mcpDef.inputSchema.properties);
    assert.deepEqual(mcpDef.inputSchema.required, ["target"]);
  });
});

describe("CapabilityGateway", () => {
  const tool: Tool = {
    name: "echo",
    description: "Echo input",
    parameters: Type.Object({ message: Type.String() }),
  };
  it("turns MCP calls into Pi ToolCalls and resolves only matching results", async () => {
    const relay = new CapabilityGateway([tool]);
    const batches: any[] = [];
    relay.setToolCallHandler((batch) => batches.push(batch));

    const resultPromise = relay.call("echo", { message: "hello" });
    await setImmediate();

    assert.equal(batches.length, 1);
    const call = batches[0].calls[0];
    assert.equal(call.type, "toolCall");
    assert.equal(call.name, "echo");
    assert.deepEqual(call.arguments, { message: "hello" });
    assert.equal(relay.hasPendingCalls, true);

    let settled = false;
    resultPromise.then(() => { settled = true; });
    assert.throws(() => relay.resolveToolResults([toolResult("different-call", false, [{ type: "text", text: "wrong" }])]), /Unknown/);
    await setImmediate();
    assert.equal(settled, false);

    relay.resolveToolResults([
      toolResult(call.id, true, [
        { type: "text", text: "failed" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ]),
    ]);
    assert.deepEqual(await resultPromise, {
      isError: true,
      content: [
        { type: "text", text: "failed" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
    });
    assert.equal(relay.hasPendingCalls, false);
  });

  for (const scenario of ["ordered", "reversed", "partial", "unknown", "duplicate", "name mismatch", "missing"] as const) {
    it(`delivers an atomic result batch: ${scenario}`, async (t) => {
      const relay = new CapabilityGateway([tool]);
      t.after(() => relay.cancelPendingCalls("cleanup"));
      const calls: string[] = [];
      relay.setToolCallHandler((batch) => calls.push(...batch.calls.map((call) => call.id)));
      let settled = 0;
      const promises = [relay.call("echo", {}), relay.call("echo", {})];
      for (const promise of promises) void promise.then(() => { settled++; });
      await setImmediate();
      const results = calls.map((id, index) => toolResult(id, index === 1, [
        { type: "text", text: `result-${index}` },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ]));
      let supplied = [...results];
      if (scenario === "reversed") supplied.reverse();
      if (scenario === "partial") supplied.pop();
      if (scenario === "missing") supplied = [];
      if (scenario === "unknown") supplied.push(toolResult("unknown", false, []));
      if (scenario === "duplicate") supplied.push(results[0]!);
      if (scenario === "name mismatch") supplied[1] = { ...results[1]!, toolName: "wrong" } as Message;
      const snapshot = structuredClone(supplied);

      if (scenario !== "ordered" && scenario !== "reversed") {
        assert.throws(() => relay.resolveToolResults(supplied, "context"));
        await setImmediate();
        assert.equal(settled, 0);
        assert.equal(relay.hasPendingCalls, true);
        supplied = results;
      }
      assert.equal(relay.resolveToolResults(supplied, "context"), 2);
      const delivered = await Promise.all(promises);
      for (let index = 0; index < 2; index++) {
        const source = results[index]! as Extract<Message, { role: "toolResult" }>;
        const last = (supplied.at(-1)! as Extract<Message, { role: "toolResult" }>).toolCallId === calls[index];
        assert.deepEqual(delivered[index], {
          isError: source.isError,
          content: [...source.content, ...(last ? [{ type: "text", text: "context" }] : [])],
        });
      }
      if (scenario === "ordered" || scenario === "reversed") assert.deepEqual(supplied, snapshot);
      assert.equal(relay.hasPendingCalls, false);
    });
  }

  for (const queued of [false, true]) {
    it(`allows no dispatched results with queued=${queued}`, async (t) => {
      const relay = new CapabilityGateway([tool]);
      t.after(() => relay.cancelPendingCalls("cleanup"));
      if (queued) void relay.call("echo", {});
      assert.equal(relay.resolveToolResults([], "context"), 0);
      assert.equal(relay.hasPendingCalls, queued);
    });
  }

  for (const withDispatched of [false, true]) {
    it(`rejects undispatched results atomically with dispatched=${withDispatched}`, async (t) => {
      const relay = new CapabilityGateway([tool]);
      t.after(() => relay.cancelPendingCalls("cleanup"));
      const ids: string[] = [];
      const original = PiToolAdapter.prototype.createCall;
      t.mock.method(PiToolAdapter.prototype, "createCall", function (this: PiToolAdapter, ...args: Parameters<PiToolAdapter["createCall"]>) {
        const call = original.apply(this, args);
        if (call) ids.push(call.id);
        return call;
      });
      const dispatched: string[] = [];
      relay.setToolCallHandler((batch) => dispatched.push(...batch.calls.map((call) => call.id)));
      const promises: Promise<unknown>[] = [];
      if (withDispatched) {
        promises.push(relay.call("echo", {}));
        await setImmediate();
      }
      relay.setToolCallHandler(null);
      promises.push(relay.call("echo", {}));
      let settled = 0;
      for (const promise of promises) void promise.then(() => { settled++; });
      const results = ids.map((id) => toolResult(id, false, [{ type: "text", text: "answer" }]));

      assert.throws(() => relay.resolveToolResults(results, "context"), /before dispatch/);
      await setImmediate();
      assert.equal(settled, 0);
      assert.equal(relay.hasPendingCalls, true);
      assert.deepEqual(dispatched, withDispatched ? [ids[0]] : []);

      relay.setToolCallHandler((batch) => dispatched.push(...batch.calls.map((call) => call.id)));
      assert.deepEqual(dispatched, ids);
      assert.equal(relay.resolveToolResults(results, "context"), ids.length);
      await Promise.all(promises);
      assert.equal(relay.hasPendingCalls, false);
    });
  }

  it("returns a structured MCP error when call conversion rejects an unknown terminal", async () => {
    const relay = new CapabilityGateway([ptyTool], new SessionResources());
    const result = await relay.call("pty", { command: "write", ptyId: "terminal-1" });
    assert.deepEqual(result, {
      isError: true,
      content: [{ type: "text", text: 'Unknown terminal handle "terminal-1".' }],
    });
    assert.equal(relay.hasPendingCalls, false);
  });

});

describe("PiToolAdapter", () => {
  it("leaves ordinary identifier fields unchanged", () => {
    const lookupTool: Tool = {
      name: "lookup",
      description: "Look up an object",
      parameters: Type.Object({ id: Type.String() }),
    };
    const adapter = new PiToolAdapter([lookupTool, ptyTool], new SessionResources());

    assert.equal(adapter.createCall("lookup", { id: "raw-object-id" })?.arguments.id, "raw-object-id");
    assert.equal(adapter.createCall("pty", { command: "inspect", id: "raw-object-id" })?.arguments.id, "raw-object-id");
  });

  it("uses session-local terminal handles for start and follow-up calls", () => {
    const resources = new SessionResources();
    const adapter = new PiToolAdapter([ptyTool], resources);
    const startCall = adapter.createCall("pty", { command: "start" });
    assert.ok(startCall);

    const started = adapter.toMcpResult({
      role: "toolResult",
      toolCallId: startCall.id,
      toolName: "pty",
      details: { ptyId: "pi-pty-abc" },
      content: [{ type: "text", text: "started" }],
      isError: false,
      timestamp: Date.now(),
    }, startCall);
    assert.equal(resources.terminals.resolve("terminal-1"), "pi-pty-abc");
    assert.equal(started.content[0]?.type, "text");

    const pollCall = adapter.createCall("pty", { command: "poll", ptyId: "terminal-1" });
    assert.equal(pollCall?.arguments.ptyId, "pi-pty-abc");
  });

  it("keeps identical visible handles isolated across sessions", () => {
    const sessionA = new PiToolAdapter([ptyTool], new SessionResources());
    const resourcesB = new SessionResources();
    const sessionB = new PiToolAdapter([ptyTool], resourcesB);
    const startA = sessionA.createCall("pty", { command: "start" })!;
    const startB = sessionB.createCall("pty", { command: "start" })!;

    sessionA.toMcpResult(adapterToolResult(startA.id, "pty-a"), startA);
    sessionB.toMcpResult(adapterToolResult(startB.id, "pty-b"), startB);

    const callA = sessionA.createCall("pty", { command: "write", ptyId: "terminal-1" });
    const callB = sessionB.createCall("pty", { command: "write", ptyId: "terminal-1" });
    assert.equal(callA?.arguments.ptyId, "pty-a");
    assert.equal(callB?.arguments.ptyId, "pty-b");
  });

  it("rejects unknown, stale, and cross-session terminal identifiers", () => {
    const resourcesA = new SessionResources();
    const sessionA = new PiToolAdapter([ptyTool], resourcesA);
    const startA = sessionA.createCall("pty", { command: "start" })!;
    sessionA.toMcpResult(adapterToolResult(startA.id, "pty-a"), startA);

    const resourcesB = new SessionResources();
    const sessionB = new PiToolAdapter([ptyTool], resourcesB);
    assert.throws(
      () => sessionB.createCall("pty", { command: "write", ptyId: "pty-a" }),
      /Unknown terminal handle/,
    );
    assert.throws(
      () => sessionB.createCall("pty", { command: "write", ptyId: "terminal-99" }),
      /Unknown terminal handle/,
    );

    resourcesA.terminals.release("terminal-1");
    assert.throws(
      () => sessionA.createCall("pty", { command: "write", ptyId: "terminal-1" }),
      /Unknown terminal handle/,
    );
  });
});

describe("isAllowedPiToolName", () => {
  const cases = [
    {
      name: "allows an explicitly bridged Pi tool",
      toolName: "mcp__pi__read",
      allowed: ["mcp__pi__read"],
      expected: true,
    },
    {
      name: "rejects a Pi MCP tool that is not in this context",
      toolName: "mcp__pi__manage_task",
      allowed: ["mcp__pi__read", "mcp__pi__bash"],
      expected: false,
    },
    {
      name: "rejects native Antigravity tools",
      toolName: "manage_task",
      allowed: ["mcp__pi__manage_task"],
      expected: false,
    },
    {
      name: "rejects another MCP server namespace",
      toolName: "mcp__other__read",
      allowed: ["mcp__other__read"],
      expected: false,
    },
  ];

  it("allows only explicitly bridged Pi tools", () => {
    for (const tc of cases) assert.equal(isAllowedPiToolName(tc.toolName, new Set(tc.allowed)), tc.expected, tc.name);
  });
});

function adapterToolResult(toolCallId: string, ptyId: string) {
  return {
    role: "toolResult" as const,
    toolCallId,
    toolName: "pty",
    details: { ptyId },
    content: [{ type: "text" as const, text: JSON.stringify({ ptyId }) }],
    isError: false,
    timestamp: Date.now(),
  };
}

function toolResult(
  toolCallId: string,
  isError: boolean,
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>
): Message {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "echo",
    content,
    isError,
    timestamp: Date.now(),
  } as Message;
}
