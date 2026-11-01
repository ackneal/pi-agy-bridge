import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { prepareBridgeMessages, serializeConversation } from "./context-prompt.ts";
import { serializeContent } from "../drivers/acp/runtime.ts";
import { serializePrompt } from "../drivers/cli/runtime.ts";

describe("conversation history reconstruction", () => {
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

  const call = (id: string, path: string): AssistantMessage => ({ ...assistantMetadata, role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path } }], stopReason: "toolUse", timestamp: 1 });
  const result = (id: string, body: string, isError = false): Extract<Context["messages"][number], { role: "toolResult" }> => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: body }], isError, timestamp: 2 });
  const completed: AssistantMessage = { ...assistantMetadata, role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 3 };

  describe("bridge message reconstruction", () => {
    it("quotes history, preserves images and omits completed result bodies", () => {
      assert.equal(serializePrompt(prepareBridgeMessages(context, true)), [
        "[System]: Follow <policy> & safety.",
        "[User]: old <question>",
        "[Assistant tool calls]:\n- read(path=\"README.md\")",
        "[Assistant]: read complete",
        "next & now",
      ].join("\n\n"));
    });

    it("serializes calls and preserves user request without result bodies", () => {
      const prompt = serializePrompt(prepareBridgeMessages({ messages: [call("old", "old"), result("old", "OLD_BODY"), completed,
        call("current", "current"), result("current", "CURRENT_BODY"), { role: "user", content: "appended", timestamp: 4 }] }, true));

      assert.ok(prompt.includes("- read(path=\"old\")"));
      assert.ok(prompt.includes("- read(path=\"current\")"));
      assert.ok(!prompt.includes("OLD_BODY"));
      assert.ok(!prompt.includes("CURRENT_BODY"));
      assert.ok(prompt.endsWith("appended"));
    });

    for (const stopReason of ["pending", "deferred"] as const) {
      it(`serializes ${stopReason} runs`, () => {
        const prompt = serializePrompt(prepareBridgeMessages({ messages: [call("active", "active-path"),
          result("active", "ACTIVE_BODY"), { ...completed, stopReason }] }, true));
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
          const prompt = serializePrompt(prepareBridgeMessages({ messages: [mixed, result("hidden", "SECRET_ONE"), result("chunk", "SECRET_TWO"),
            result("visible", "VISIBLE_BODY"), ...(old ? [completed] : [])] }, true));

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
        const prompt = serializePrompt(prepareBridgeMessages({ messages }, true));

        assert.equal(prompt.match(/- read\(path=/g)?.length ?? 0, calls);
        for (const value of kept) assert.ok(prompt.includes(value), value);
        for (const value of removed) assert.ok(!prompt.includes(value), value);
        assert.deepEqual(messages, before);
      });
    }

    it("truncates long arguments exceeding 300 characters with ellipsis", () => {
      const args = "x".repeat(500);
      const prompt = serializePrompt(prepareBridgeMessages({ messages: [call("args", args), completed] }, true));
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
      const prompt = serializePrompt(prepareBridgeMessages({ messages }, true));
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

  for (const { name, input, enabled, rebuild } of ([
    { name: "completed results", input: { systemPrompt: "PRIVATE_SYSTEM", messages: [call("private-id", "PRIVATE_PATH"), result("private-id", "PRIVATE_BODY"), completed] } },
    { name: "argument truncation", input: { messages: [call("private-id", "x".repeat(2000)), completed] } },
    { name: "plain user", input: { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] } },
  ] satisfies { name: string; input: Context }[]).flatMap((row) => [false, true].flatMap((enabled) => [false, true].map((rebuild) => ({ ...row, enabled, rebuild }))))) {
    it(`logs numeric metrics only on enabled rebuild (${name}, debug=${enabled}, rebuild=${rebuild})`, () => {
      const previous = process.env["AGY_BRIDGE_DEBUG"];
      process.env["AGY_BRIDGE_DEBUG"] = enabled ? "1" : "0";
      const write = process.stderr.write;
      let logged = "";
      process.stderr.write = ((chunk: string | Uint8Array) => { logged += String(chunk); return true; }) as typeof write;
      try {
        const messages = prepareBridgeMessages(input, rebuild);
        assert.equal(Boolean(logged), enabled && rebuild);
        if (enabled && rebuild) {
          const metrics = JSON.parse(logged.slice(logged.indexOf("{")));
          assert.equal(metrics.inputChars, JSON.stringify(input.messages).length + ("systemPrompt" in input ? input.systemPrompt.length : 0));
          const text = messages.flatMap((message) => typeof message.content === "string" ? [message.content]
            : message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).join("");
          assert.equal(metrics.textChars, text.length);
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
});

describe("tool result semantics", () => {
  type Call = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
  type Result = Extract<Message, { role: "toolResult" }>;
  const metadata: Pick<AssistantMessage, "api" | "provider" | "model" | "usage"> = {
    api: "agy", provider: "agy", model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const call = (id: string, path: string, name = "read", args?: Call["arguments"]): Call =>
    ({ type: "toolCall", id, name, arguments: args ?? { path } });
  const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage =>
    ({ ...metadata, role: "assistant", content, stopReason, timestamp: 1 });
  const terminal = (stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => assistant([], stopReason);
  const result = (id: string, text = "PRIVATE_RESULT_BODY", isError = false, toolName = "read"): Result =>
    ({ role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }], isError, timestamp: 2 });

  function row(prompt: string, path: string, status: string): void {
    const line = prompt.split("\n").find((value) => value.includes(path));
    assert.ok(line, `missing operation row for ${path}:\n${prompt}`);
    if (status === "SUCCESS") {
      assert.doesNotMatch(line, /— (?:ERROR|ABORTED|UNKNOWN)/);
    } else {
      assert.match(line, new RegExp(`— ${status}(?:\\b|:)`));
    }
  }
  function ordered(prompt: string, values: string[]): void {
    let previous = -1;
    for (const value of values) {
      const next = prompt.indexOf(value, previous + 1);
      assert.ok(next > previous, `missing/out-of-order ${value}:\n${prompt}`);
      previous = next;
    }
  }
  interface CompletedCase { name: string; messages: Message[]; check: (prompt: string) => void }
  const cases: CompletedCase[] = [
    {
      name: "call order survives reversed results and contiguous names regroup after another tool",
      messages: [assistant([call("id-one", "first"), call("id-two", "second"), call("id-bash", "", "bash", { command: "pwd" }), call("id-three", "third")]),
        result("id-three"), result("id-bash", "output", false, "bash"), result("id-two"), result("id-one"), terminal()],
      check(prompt) {
        ordered(prompt, ["first", "second", "pwd", "third"]);
        for (const path of ["first", "second", "pwd", "third"]) row(prompt, path, "SUCCESS");
      },
    },
    ...(["assistant text", "user", "system", "terminal"] as const).map((boundary): CompletedCase => {
      const middle: Message[] = boundary === "assistant text" ? [assistant([{ type: "text", text: "BOUNDARY" }])]
        : boundary === "user" ? [{ role: "user", content: "BOUNDARY", timestamp: 3 }]
        : boundary === "system" ? [{ role: "system", content: "BOUNDARY", timestamp: 3 }]
        : [terminal()];
      return {
        name: `${boundary} splits same-name completed groups`,
        messages: [assistant([call("id-before", "before")]), result("id-before"), ...middle,
          assistant([call("id-after", "after")]), result("id-after"), terminal()],
        check(prompt) {
          ordered(prompt, ["before", "after"]);
          if (boundary !== "terminal") ordered(prompt, ["before", "BOUNDARY", "after"]);
        },
      };
    }),
    {
      name: "edit and write retain paths but not payloads",
      messages: [assistant([call("id-edit", "", "edit", { path: "edit.ts", oldText: "PRIVATE_OLD", newText: "PRIVATE_NEW" }),
        call("id-write", "", "write", { path: "write.ts", content: "PRIVATE_CONTENT" })]),
        result("id-edit", "PRIVATE_DIFF", false, "edit"), result("id-write", "PRIVATE_WRITE", false, "write"), terminal()],
      check(prompt) { row(prompt, "edit.ts", "SUCCESS"); row(prompt, "write.ts", "SUCCESS"); assert.doesNotMatch(prompt, /PRIVATE_/); },
    },
    ...(["user", "system"] as const).map((boundary): CompletedCase => {
      const message: Message = boundary === "user"
        ? { role: "user", content: "NEW_REQUEST", timestamp: 3 }
        : { role: "system", content: "SYSTEM_BOUNDARY", timestamp: 3 };
      const marker = boundary === "user" ? "NEW_REQUEST" : "SYSTEM_BOUNDARY";
      return {
        name: `${boundary} boundary keeps a later result unpaired`,
        messages: [assistant([call("id-separated", "before-boundary")]), message, result("id-separated"), terminal()],
        check(prompt) {
          row(prompt, "before-boundary", "UNKNOWN");
          ordered(prompt, ["before-boundary", marker]);
          assert.doesNotMatch(prompt, /SUCCESS/);
        },
      };
    }),
    ...(["user", "system"] as const).map((boundary): CompletedCase => {
      const message: Message = boundary === "user"
        ? { role: "user", content: "NEW_REQUEST", timestamp: 3 }
        : { role: "system", content: "SYSTEM_BOUNDARY", timestamp: 3 };
      return {
        name: `aborted inference stops at ${boundary} boundary`,
        messages: [assistant([call("id-abort", "first-request")]), message,
          assistant([call("id-next", "second-request")]), terminal("aborted")],
        check(prompt) {
          row(prompt, "first-request", "UNKNOWN");
          row(prompt, "second-request", "ABORTED");
        },
      };
    }),
    {
      name: "a hidden assistant boundary cannot confirm an earlier call",
      messages: [assistant([call("id-hidden", "uncertain")]), assistant([{ type: "thinking", thinking: "PRIVATE_THINK" }]),
        result("id-hidden"), terminal()],
      check(prompt) { row(prompt, "uncertain", "UNKNOWN"); assert.doesNotMatch(prompt, /PRIVATE_THINK/); },
    },
    {
      name: "terminal assistant calls keep their status and cannot merge with the next run",
      messages: [assistant([call("id-before", "before")], "aborted"),
        assistant([call("id-after", "after")]), result("id-after"), terminal()],
      check(prompt) {
        row(prompt, "before", "ABORTED"); row(prompt, "after", "SUCCESS");
        ordered(prompt, ["before", "after"]);
      },
    },
    {
      name: "ID plus tool name disambiguates parallel calls",
      messages: [assistant([call("id-shared", "input.ts"), call("id-shared", "", "write", { path: "output.ts", content: "PRIVATE_WRITE" })]),
        result("id-shared", "written", false, "write"), result("id-shared"), terminal()],
      check(prompt) {
        row(prompt, "input.ts", "SUCCESS"); row(prompt, "output.ts", "SUCCESS");
        assert.doesNotMatch(prompt, /UNKNOWN|PRIVATE_WRITE/);
      },
    },
    ...[
      { name: "bash failure selects exit-code line instead of stdout", tool: "bash", body: "hello\n\nCommand exited with code 1", status: "ERROR", reason: "Command exited with code 1" },
      { name: "bash abort", tool: "bash", body: "Command aborted", status: "ABORTED", reason: "Command aborted" },
      { name: "generic exact abort", tool: "custom", body: "Operation aborted", status: "ABORTED", reason: "Operation aborted" },
      { name: "an abort-like first line alone does not prove cancellation", tool: "custom", body: "Operation aborted\nPermission denied", status: "ERROR", reason: "Operation aborted" },
    ].map(({ name, tool, body, status, reason }): CompletedCase => ({
      name, messages: [assistant([call("id-error", "", tool, { command: "failing-command" })]), result("id-error", body, true, tool), terminal()],
      check(prompt) { assert.match(prompt, new RegExp(status)); if (status !== "ABORTED") assert.ok(prompt.includes(reason), prompt); assert.doesNotMatch(prompt, /hello/); assert.doesNotMatch(prompt, /SUCCESS/); },
    })),
    {
      name: "successful result remains successful before aborted terminal",
      messages: [assistant([call("id-success", "finished")]), result("id-success"), terminal("aborted")],
      check(prompt) { row(prompt, "finished", "SUCCESS"); },
    },
    {
      name: "missing result at aborted terminal has unknown completion",
      messages: [assistant([call("id-missing", "unfinished")]), terminal("aborted")],
      check(prompt) { row(prompt, "unfinished", "ABORTED"); assert.doesNotMatch(prompt, /SUCCESS/); },
    },
    ...[
      { name: "missing result", calls: [call("id-missing", "uncertain")], results: [] },
      { name: "empty ID", calls: [call("", "uncertain")], results: [result("")] },
      { name: "duplicate results", calls: [call("id-duplicate", "uncertain")], results: [result("id-duplicate"), result("id-duplicate")] },
      { name: "ambiguous call IDs", calls: [call("id-shared", "uncertain"), call("id-shared", "other")], results: [result("id-shared")] },
    ].map(({ name, calls, results }): CompletedCase => ({
      name: `${name} never implies success`, messages: [assistant(calls), ...results, terminal()],
      check(prompt) { row(prompt, "uncertain", "UNKNOWN"); assert.doesNotMatch(prompt, /SUCCESS/); },
    })),
    {
      name: "merges consecutive contiguous file reads across assistant turns into one range",
      messages: [
        assistant([call("id-one", "", "read", { path: "src/extension/drivers/acp/installation.test.ts", offset: 1, limit: 150 })]),
        result("id-one"),
        assistant([call("id-two", "", "read", { path: "src/extension/drivers/acp/installation.test.ts", offset: 151, limit: 150 })]),
        result("id-two"),
        assistant([call("id-three", "", "read", { path: "src/extension/drivers/acp/installation.test.ts", offset: 301, limit: 150 })]),
        result("id-three"),
        terminal(),
      ],
      check(prompt) {
        assert.equal(prompt, '[Assistant tool calls]:\n- read(path="src/extension/drivers/acp/installation.test.ts", offset=1, limit=450)');
      },
    },
    {
      name: "merges consecutive contiguous file reads within the same assistant turn",
      messages: [
        assistant([
          call("id-one", "", "read", { path: "file.ts", limit: 150 }),
          call("id-two", "", "read", { path: "file.ts", offset: 151, limit: 150 }),
        ]),
        result("id-one"),
        result("id-two"),
        terminal(),
      ],
      check(prompt) {
        assert.equal(prompt, '[Assistant tool calls]:\n- read(path="file.ts", offset=1, limit=300)');
      },
    },
    {
      name: "does not merge disjoint or failed file reads",
      messages: [
        assistant([call("id-one", "", "read", { path: "file.ts", offset: 1, limit: 100 })]),
        result("id-one"),
        assistant([call("id-two", "", "read", { path: "file.ts", offset: 201, limit: 100 })]),
        result("id-two"),
        assistant([call("id-three", "", "read", { path: "file.ts", offset: 301, limit: 100 })]),
        result("id-three", "Permission denied", true),
        terminal(),
      ],
      check(prompt) {
        assert.ok(prompt.includes('- read(path="file.ts", offset=1, limit=100)'), prompt);
        assert.ok(prompt.includes('- read(path="file.ts", offset=201, limit=100)'), prompt);
        assert.ok(prompt.includes('- read(path="file.ts", offset=301, limit=100) — ERROR: Permission denied'), prompt);
      },
    },
  ];

  for (const { name, messages, check } of cases) {
    it(`completed context: ${name}`, () => {
      const before = structuredClone(messages);
      const prompt = serializeConversation(messages);

      check(prompt);
      assert.doesNotMatch(prompt, /id:|id-(?:one|two|bash|three|before|after|edit|write|error|success|missing|duplicate|shared|orphan)|Body omitted|body omitted|PRIVATE_RESULT_BODY/);
      assert.deepEqual(messages, before);
    });
  }

  for (const stopReason of ["pending", "deferred"] as const) {
    it(`completed context: ${stopReason} assistant serializes tool calls`, () => {
      const args = { path: "latest.ts", content: "FULL_ARGUMENT_" + "x".repeat(1500) };
      const messages: Message[] = [assistant([call("id-current", "", "write", args)]), result("id-current", "CURRENT_BODY", false, "write"), terminal(stopReason)];
      const prompt = serializeConversation(messages);

      assert.ok(prompt.includes("- write(path=\"latest.ts\")"), prompt);
      assert.doesNotMatch(prompt, /FULL_ARGUMENT_|CURRENT_BODY/);
    });
  }

  const image = { type: "image", mimeType: "image/png", data: "PRIVATE_BASE64_" + "A".repeat(1_000_000) } as const;
  for (const mode of ["completed", "user", "incremental"] as const) {
    it(`completed context: ${mode} images do not leak base64 payloads`, () => {
      const imageResult: Result = { ...result("id-image"), content: [{ type: "text", text: "IMAGE_ERROR" }, image], isError: true };
      const messages: Message[] = mode === "user" || mode === "incremental"
        ? [{ role: "user", content: [{ type: "text", text: "IMAGE_REQUEST" }, image], timestamp: 1 }]
        : [assistant([call("id-image", "picture.png")]), imageResult, terminal()];
      const context: Context = { messages };
      const prompt = serializePrompt(prepareBridgeMessages(context, mode !== "incremental", 0));

      assert.ok(prompt.length < 5000, `image payload expanded output to ${prompt.length}`);
      assert.doesNotMatch(prompt, /PRIVATE_BASE64|AAAA|data:image/);
      if (mode === "completed") {
        assert.ok(prompt.includes("- read(path=\"picture.png\")"));
      }
    });
  }
});

describe("incremental updates", () => {
  const oldMessage: Message = { role: "user", content: "OLD_HISTORY_SENTINEL", timestamp: 1 };
  const image = { type: "image", mimeType: "image/png", data: "AAECA/8=" } as const;
  interface Case {
    name: string;
    context: Context;
    isReused: boolean;
    syncedMessageCount?: number;
    exact?: string;
    expected?: string;
  }

  const cases: Case[] = [
    ...[
      { name: "string", content: "next <request> & now" },
      { name: "text block", content: [{ type: "text" as const, text: "next <request> & now" }] },
    ].map(({ name, content }): Case => ({
      name: `retains plain output for one new user ${name}`,
      context: { messages: [oldMessage, { role: "user", content, timestamp: 2 }] },
      isReused: true, syncedMessageCount: 1, exact: "next <request> & now",
    })),
    {
      name: "retains latest plain user output without an explicit sync count",
      context: { messages: [oldMessage, { role: "user", content: "latest", timestamp: 2 }] },
      isReused: true, exact: "latest",
    },
    {
      name: "slices all new messages rather than only the latest",
      context: { messages: [oldMessage,
        { role: "user", content: "first <new>", timestamp: 2 },
        { role: "user", content: "second & new", timestamp: 3 },
      ] },
      isReused: true, syncedMessageCount: 1,
      exact: "first <new>\n\nsecond & new",
    },
    {
      name: "zero synced messages includes the entire new slice",
      context: { messages: [{ role: "system", content: "new rules", timestamp: 1 }, { role: "user", content: "request", timestamp: 2 }] },
      isReused: true, syncedMessageCount: 0,
      expected: "[System]: # Conversation updates\n\n## System\n\n> new rules\n\nrequest",
    },
    {
      name: "formats a single new system message as quoted Markdown",
      context: { messages: [oldMessage, { role: "system", content: "rules & policy", timestamp: 2 }] },
      isReused: true, syncedMessageCount: 1,
      expected: "[System]: # Conversation updates\n\n## System\n\n> rules & policy",
    },
    {
      name: "omits image blocks for incremental user prompt in CLI",
      context: { messages: [oldMessage, { role: "user", content: [{ type: "text", text: "look" }, image], timestamp: 2 }] },
      isReused: true, syncedMessageCount: 1,
      exact: "look",
    },
    ...[
      { name: "fully synced history", messages: [oldMessage], syncedMessageCount: 1 },
      { name: "empty context", messages: [], syncedMessageCount: 0 },
    ].map(({ name, messages, syncedMessageCount }): Case => ({
      name: `returns empty output for ${name}`,
      context: { messages }, isReused: true, syncedMessageCount, exact: "",
    })),
  ];

  describe("bridge message context updates", () => {
    for (const { name, context, isReused, syncedMessageCount, exact, expected } of cases) {
      it(name, () => {
        const prompt = serializePrompt(prepareBridgeMessages(context, !isReused, syncedMessageCount));

        if (exact !== undefined) assert.equal(prompt, exact);
        if (expected !== undefined) assert.equal(prompt, expected);
        assert.ok(!prompt.includes("data:image/"));
        assert.ok(!prompt.includes(image.data));
      });
    }
  });
});

describe("explicit conversation continuation", () => {
  const user: Context["messages"][number] = { role: "user", content: "Do the work", timestamp: 1 };
  for (const row of [
    { name: "new user input remains verbatim", messages: [user], synced: 0, expected: "Do the work" },
    { name: "empty new user input", messages: [{ ...user, content: "" }], synced: 0, expected: "" },
  ]) {
    test(row.name, () => {
      assert.equal(serializePrompt(prepareBridgeMessages({ messages: row.messages }, false, row.synced)), row.expected);
    });
  }
});

describe("message metadata", () => {
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
});

test("standalone raw content bypasses markdown transcript wrapping", () => {
  const context = {
    systemPrompt: "Summarize directly",
    messages: [
      { role: "user" as const, content: "<conversation>detail</conversation>", timestamp: 1 },
    ],
  };

  const bridgeMessages = prepareBridgeMessages(context, true);
  const acpBlocks = serializeContent(bridgeMessages);
  assert.deepEqual(acpBlocks, [{ type: "text", text: "<conversation>detail</conversation>" }]);
  assert.ok(!acpBlocks.some((b) => b.type === "text" && (b.text.includes("## User") || b.text.startsWith("> ") || b.text.includes("\n> "))));

  const cliPrompt = serializePrompt(bridgeMessages);
  assert.equal(cliPrompt, "[System]: Summarize directly\n\n<conversation>detail</conversation>");
  assert.ok(!cliPrompt.includes("# System prompt"));
  assert.ok(!cliPrompt.includes("## User"));
  assert.ok(!cliPrompt.startsWith("> ") && !cliPrompt.includes("\n> "));
});
