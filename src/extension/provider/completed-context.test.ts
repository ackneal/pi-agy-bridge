import assert from "node:assert/strict";
import { it } from "node:test";
import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { prepareBridgeMessages, serializeConversation } from "./context-prompt.ts";
import { serializeCliPrompt } from "../drivers/cli/runtime.ts";

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
    const prompt = serializeCliPrompt(prepareBridgeMessages(context, mode !== "incremental", 0));

    assert.ok(prompt.length < 5000, `image payload expanded output to ${prompt.length}`);
    assert.doesNotMatch(prompt, /PRIVATE_BASE64|AAAA|data:image/);
    if (mode === "completed") {
      assert.ok(prompt.includes("- read(path=\"picture.png\")"));
    }
  });
}
