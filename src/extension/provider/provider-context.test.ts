import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { formatContextPrompt } from "./context-prompt.ts";

const assistantMetadata: Pick<AssistantMessage, "api" | "provider" | "model" | "usage"> = {
  api: "agy",
  provider: "agy",
  model: "test",
  usage: {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

const context: Context = {
  systemPrompt: "Follow <policy> & safety.",
  tools: [],
  messages: [
    {
      role: "user",
      content: "old <question>",
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call-1",
        name: "read",
        arguments: { path: "README.md" },
      }],
      ...assistantMetadata,
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
      timestamp: 3,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "read complete" }],
      ...assistantMetadata,
      stopReason: "stop",
      timestamp: 4,
    },
    {
      role: "user",
      content: [
        { type: "text", text: "next & now" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
      timestamp: 5,
    },
  ],
};

const historyHeading = "# Conversation history\n\nThese messages restore prior conversation state. Do not repeat completed actions. Continue unfinished work, respecting later corrections and cancellations.";
const call = (id: string, path: string): AssistantMessage => ({ ...assistantMetadata, role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path } }], stopReason: "toolUse", timestamp: 1 });
const result = (id: string, body: string, isError = false): Extract<Context["messages"][number], { role: "toolResult" }> => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: body }], isError, timestamp: 2 });
const completed: AssistantMessage = { ...assistantMetadata, role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 3 };

describe("formatContextPrompt reconstruction", () => {
  it("quotes history, preserves images and omits completed result bodies", () => {
    assert.equal(formatContextPrompt(context, false), [
      "[System]: Follow <policy> & safety.",
      "[User]: old <question>",
      "[Assistant tool calls]:\n- read(path=\"README.md\")",
      "[Assistant]: read complete",
      "next & now",
    ].join("\n\n"));
  });

  it("serializes calls and preserves user request without result bodies", () => {
    const prompt = formatContextPrompt({ messages: [call("old", "old"), result("old", "OLD_BODY"), completed,
      call("current", "current"), result("current", "CURRENT_BODY"), { role: "user", content: "appended", timestamp: 4 }] }, false);

    assert.ok(prompt.includes("- read(path=\"old\")"));
    assert.ok(prompt.includes("- read(path=\"current\")"));
    assert.ok(!prompt.includes("OLD_BODY"));
    assert.ok(!prompt.includes("CURRENT_BODY"));
    assert.ok(prompt.endsWith("appended"));
  });

  for (const stopReason of ["pending", "deferred"] as const) {
    it(`serializes ${stopReason} runs`, () => {
      const prompt = formatContextPrompt({ messages: [call("active", "active-path"),
        result("active", "ACTIVE_BODY"), { ...completed, stopReason }] }, false);
      assert.ok(prompt.includes("- read(path=\"active-path\")"));
      assert.ok(!prompt.includes("ACTIVE_BODY"));
    });
  }

  for (const old of [false, true]) {
    for (const { path, removed } of [
      { path: "/any/root/.gemini/antigravity-cli/brain/session/.system_generated/file", removed: true },
      { path: ".gemini/antigravity-cli/brain/session/.system_generated/chunk", removed: true },
      { path: "C:\\other\\.gemini\\antigravity-cli\\brain\\session\\.system_generated\\file", removed: true },
      { path: "/root/.gemini/antigravity-cli/brain/session/other/../.system_generated/file", removed: true },
      { path: "/root/.gemini/antigravity-cli/brain/session/.system_generated-other/file", removed: false },
      { path: "/root/.gemini/antigravity-cli/brain/session/notes/file", removed: false },
      { path: "/root/.gemini/antigravity-cli/brain/session/.system_generated/../../safe", removed: false },
      { path: "/root/.gemini/antigravity-cli/brain/session/.system_generated/file\0", removed: false },
    ]) {
      it(`filters paired chunk reads in mixed assistants (${old ? "old" : "current"}, ${JSON.stringify(path)})`, () => {
        const hidden = call("hidden", path);
        const mixed: AssistantMessage = { ...hidden, content: [{ type: "text", text: "retained explanation" }, ...hidden.content,
          ...call("chunk", path).content, ...call("visible", "README.md").content] };
        const prompt = formatContextPrompt({ messages: [mixed, result("hidden", "SECRET_ONE"), result("chunk", "SECRET_TWO"),
          result("visible", "VISIBLE_BODY"), ...(old ? [completed] : [])] }, false);

        assert.equal(prompt.includes(`path=${JSON.stringify(path)}`), !removed);
        assert.ok(prompt.includes("[Assistant]: retained explanation"));
        assert.ok(prompt.includes("- read(path=\"README.md\")"));
        assert.ok(!prompt.includes("SECRET_ONE"));
        assert.ok(!prompt.includes("VISIBLE_BODY"));
      });
    }
  }

  for (const { name, messages, calls, kept, removed } of [
    {
      name: "generated read before ID reuse in a later run",
      messages: [call("shared", "/root/.gemini/antigravity-cli/brain/id/.system_generated/output.txt"), result("shared", "TEMP_BODY"), completed,
        call("shared", "README.md"), result("shared", "REAL_BODY")],
      calls: 1, kept: ["README.md"], removed: ["TEMP_BODY", ".system_generated"],
    },
    {
      name: "generated read after ID reuse in the same run",
      messages: [call("shared", "README.md"), result("shared", "REAL_BODY"),
        call("shared", "/root/.gemini/antigravity-cli/brain/id/.system_generated/output.txt"), result("shared", "TEMP_BODY")],
      calls: 1, kept: ["README.md"], removed: ["TEMP_BODY", ".system_generated"],
    },
    {
      name: "ambiguous duplicate IDs in one assistant batch are retained",
      messages: [{ ...call("shared", "README.md"), content: [
        ...call("shared", "README.md").content,
        ...call("shared", "/root/.gemini/antigravity-cli/brain/id/.system_generated/output.txt").content,
      ] }, result("shared", "REAL_BODY"), result("shared", "TEMP_BODY")],
      calls: 2, kept: ["README.md"], removed: [],
    },
    {
      name: "only one corresponding result is removed",
      messages: [call("shared", "/root/.gemini/antigravity-cli/brain/id/.system_generated/output.txt"),
        result("shared", "TEMP_BODY"), result("shared", "UNPAIRED_BODY")],
      calls: 0, kept: [], removed: ["TEMP_BODY", ".system_generated"],
    },
    {
      name: "a new assistant message closes the previous batch",
      messages: [call("shared", "/root/.gemini/antigravity-cli/brain/id/.system_generated/output.txt"), completed,
        result("shared", "UNPAIRED_BODY")],
      calls: 0, kept: [], removed: [".system_generated"],
    },
    {
      name: "a result from a different tool with the same ID is retained",
      messages: [call("shared", "/root/.gemini/antigravity-cli/brain/id/.system_generated/output.txt"),
        { ...result("shared", "BASH_BODY"), toolName: "bash" }, result("shared", "TEMP_BODY")],
      calls: 0, kept: [], removed: ["TEMP_BODY", ".system_generated"],
    },
    {
      name: "user and system updates do not break the current tool batch",
      messages: [call("shared", "/root/.gemini/antigravity-cli/brain/id/.system_generated/output.txt"),
        { role: "user", content: "Keep this update", timestamp: 4 } as Context["messages"][number],
        { role: "system", content: "Keep this rule", timestamp: 5 } as Context["messages"][number], result("shared", "TEMP_BODY")],
      calls: 0, kept: ["Keep this update", "Keep this rule"], removed: ["TEMP_BODY", ".system_generated"],
    },
    {
      name: "a result preceding the generated read is retained",
      messages: [result("shared", "EARLIER_BODY"),
        call("shared", "/root/.gemini/antigravity-cli/brain/id/.system_generated/output.txt"), result("shared", "TEMP_BODY")],
      calls: 0, kept: [], removed: ["TEMP_BODY", ".system_generated"],
    },
  ]) {
    it(`scopes generated-read filtering: ${name}`, () => {
      const before = structuredClone(messages);
      const prompt = formatContextPrompt({ messages }, false);

      assert.equal(prompt.match(/- read\(path=/g)?.length ?? 0, calls);
      for (const value of kept) assert.ok(prompt.includes(value), value);
      for (const value of removed) assert.ok(!prompt.includes(value), value);
      assert.deepEqual(messages, before);
    });
  }

  it("truncates long arguments exceeding 300 characters with ellipsis", () => {
    const args = "x".repeat(500);
    const prompt = formatContextPrompt({ messages: [call("args", args), completed] }, false);
    assert.ok(prompt.includes("…"));
    assert.ok(!prompt.includes("x".repeat(350)));
  });
});

for (const { name, messages, expected, absent } of [
  { name: "out of order results retain call order", messages: [{ ...call("a", "first"), content: [...call("a", "first").content, ...call("b", "second").content] }, result("b", "bad", true), result("a", "ok"), completed], expected: ["- read(path=\"first\")", "- read(path=\"second\") — ERROR: bad"], absent: ["id:", "Body omitted"] },
  { name: "duplicates are unknown", messages: [call("a", "file"), result("a", "ok"), result("a", "ok"), completed], expected: ["- read(path=\"file\") — UNKNOWN"], absent: ["SUCCESS"] },
  { name: "missing aborted call", messages: [call("a", "file"), { ...completed, stopReason: "aborted" as const }], expected: ["- read(path=\"file\") — ABORTED"], absent: ["SUCCESS"] },
  { name: "missing call is unknown", messages: [call("a", "file"), completed], expected: ["- read(path=\"file\") — UNKNOWN"], absent: ["SUCCESS"] },
  { name: "reused IDs pair per batch", messages: [call("a", "one"), result("a", "ok"), call("a", "two"), result("a", "failure", true), completed], expected: ["- read(path=\"one\")", "- read(path=\"two\") — ERROR: failure"], absent: ["UNKNOWN"] },
  { name: "text splits groups", messages: [{ ...call("a", "one"), content: [...call("a", "one").content, { type: "text" as const, text: "between" }, ...call("b", "two").content] }, result("a", "ok"), result("b", "ok"), completed], expected: ["- read(path=\"one\")", "- read(path=\"two\")", "between"], absent: ["id:"] },
]) {
  it(name, () => {
    const before = structuredClone(messages);
    const prompt = formatContextPrompt({ messages }, false);
    let position = -1;
    for (const value of expected) {
      const next = prompt.indexOf(value, position + 1);
      assert.ok(next > position, value);
      position = next;
    }
    for (const value of absent) assert.ok(!prompt.includes(value), value);
    assert.deepEqual(messages, before);
  });
}

for (const { name, input, enabled } of ([
  { name: "completed results", input: { systemPrompt: "PRIVATE_SYSTEM", messages: [call("private-id", "PRIVATE_PATH"), result("private-id", "PRIVATE_BODY"), completed] } },
  { name: "argument truncation", input: { messages: [call("private-id", "x".repeat(2000)), completed] } },
  { name: "plain user", input: { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] } },
] satisfies { name: string; input: Context }[]).flatMap((row) => [false, true].map((enabled) => ({ ...row, enabled })))) {
  it(`logs numeric rebuild metrics only when enabled (${name}, ${enabled})`, () => {
    const previous = process.env["AGY_BRIDGE_DEBUG"];
    process.env["AGY_BRIDGE_DEBUG"] = enabled ? "1" : "0";
    const write = process.stderr.write;
    let logged = "";
    process.stderr.write = ((chunk: string | Uint8Array) => { logged += String(chunk); return true; }) as typeof write;
    try {
      const prompt = formatContextPrompt(input, false);
      assert.equal(Boolean(logged), enabled);
      if (enabled) {
        const metrics = JSON.parse(logged.slice(logged.indexOf("{")));
        assert.equal(metrics.inputChars, JSON.stringify(input.messages).length + ("systemPrompt" in input ? input.systemPrompt.length : 0));
        assert.equal(metrics.finalChars, prompt.length);
        assert.ok(!logged.includes("private-id"));
        assert.ok(Object.values(metrics).every((value) => typeof value === "number"));
        assert.ok(!logged.includes("PRIVATE"));
      }
    } finally {
      process.stderr.write = write;
      if (previous === undefined) delete process.env["AGY_BRIDGE_DEBUG"];
      else process.env["AGY_BRIDGE_DEBUG"] = previous;
    }
  });
}
