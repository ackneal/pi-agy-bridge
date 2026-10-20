import assert from "node:assert/strict";
import { it } from "node:test";
import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { formatContextPrompt, formatContextUpdate } from "./context-prompt.ts";

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

function semantic(prompt: string): string {
  return prompt.split("\n").map((line) => line.replace(/^> ?/, "")).join("\n");
}
function row(prompt: string, path: string, status: string): void {
  const line = semantic(prompt).split("\n").find((value) => value === `- ${path}` || value.startsWith(`- ${path} —`));
  assert.ok(line, `missing operation row for ${path}:\n${prompt}`);
  if (status === "SUCCESS") assert.equal(line, `- ${path}`);
  else assert.match(line, new RegExp(`— ${status}(?:\\b|:)`));
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
      ordered(semantic(prompt), ["read:", "first", "second", "bash:", "pwd", "read:", "third"]);
      assert.equal(semantic(prompt).match(/^read:$/gm)?.length, 2);
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
        assert.equal(semantic(prompt).match(/^read:$/gm)?.length, 2, prompt);
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
  {
    name: "a hidden assistant boundary cannot confirm an earlier call",
    messages: [assistant([call("id-hidden", "uncertain")]), assistant([{ type: "thinking", thinking: "PRIVATE_THINK" }]),
      result("id-hidden"), terminal()],
    check(prompt) { row(prompt, "uncertain", "UNKNOWN"); assert.match(prompt, /Unpaired result — UNKNOWN/); assert.doesNotMatch(prompt, /PRIVATE_THINK/); },
  },
  {
    name: "terminal assistant calls keep their status and cannot merge with the next run",
    messages: [assistant([call("id-before", "before")], "aborted"),
      assistant([call("id-after", "after")]), result("id-after"), terminal()],
    check(prompt) {
      row(prompt, "before", "ABORTED"); row(prompt, "after", "SUCCESS");
      assert.equal(semantic(prompt).match(/^read:$/gm)?.length, 2);
      ordered(prompt, ["before", "## Assistant (status: aborted)", "after"]);
    },
  },
  {
    name: "ID plus tool name disambiguates parallel calls",
    messages: [assistant([call("id-shared", "input.ts"), call("id-shared", "", "write", { path: "output.ts", content: "PRIVATE_WRITE" })]),
      result("id-shared", "written", false, "write"), result("id-shared"), terminal()],
    check(prompt) {
      row(prompt, "input.ts", "SUCCESS"); row(prompt, "output.ts", "SUCCESS");
      assert.doesNotMatch(prompt, /UNKNOWN|Unpaired result|PRIVATE_WRITE/);
    },
  },
  ...[
    { name: "bash failure selects exit-code line instead of stdout", tool: "bash", body: "hello\n\nCommand exited with code 1", status: "ERROR", reason: "Command exited with code 1" },
    { name: "bash abort", tool: "bash", body: "Command aborted", status: "ABORTED", reason: "Command aborted" },
    { name: "generic exact abort", tool: "custom", body: "Operation aborted", status: "ABORTED", reason: "Operation aborted" },
    { name: "an abort-like first line alone does not prove cancellation", tool: "custom", body: "Operation aborted\nPermission denied", status: "ERROR", reason: "Operation aborted" },
  ].map(({ name, tool, body, status, reason }): CompletedCase => ({
    name, messages: [assistant([call("id-error", "", tool, { command: "failing-command" })]), result("id-error", body, true, tool), terminal()],
    check(prompt) { assert.match(prompt, new RegExp(status)); assert.ok(prompt.includes(reason), prompt); assert.doesNotMatch(prompt, /hello/); assert.doesNotMatch(prompt, /SUCCESS/); },
  })),
  {
    name: "successful result remains successful before aborted terminal",
    messages: [assistant([call("id-success", "finished")]), result("id-success"), terminal("aborted")],
    check(prompt) { row(prompt, "finished", "SUCCESS"); },
  },
  {
    name: "missing result at aborted terminal has unknown completion",
    messages: [assistant([call("id-missing", "unfinished")]), terminal("aborted")],
    check(prompt) { row(prompt, "unfinished", "ABORTED"); assert.match(prompt, /completion unknown/i); assert.doesNotMatch(prompt, /SUCCESS/); },
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
  ...[
    { body: "Permission denied", status: "ERROR" },
    { body: "Operation aborted", status: "ABORTED" },
  ].map(({ body, status }): CompletedCase => ({
    name: `orphan preserves ${status}`, messages: [result("id-orphan", body, true), terminal()],
    check(prompt) { assert.match(prompt, new RegExp(status)); assert.doesNotMatch(prompt, /SUCCESS/); },
  })),
];

for (const { name, messages, check } of cases) {
  it(`completed context: ${name}`, () => {
    const before = structuredClone(messages);
    const prompt = formatContextPrompt({ messages }, false);

    check(prompt);
    assert.doesNotMatch(prompt, /id:|id-(?:one|two|bash|three|before|after|edit|write|error|success|missing|duplicate|shared|orphan)|Body omitted|body omitted|PRIVATE_RESULT_BODY/);
    assert.deepEqual(messages, before);
  });
}

for (const stopReason of ["pending", "deferred"] as const) {
  it(`completed context: ${stopReason} assistant does not complete latest tools`, () => {
    const args = { path: "latest.ts", content: "FULL_ARGUMENT_" + "x".repeat(1500) };
    const messages: Message[] = [assistant([call("id-current", "", "write", args)]), result("id-current", "CURRENT_BODY", false, "write"), terminal(stopReason)];
    const prompt = formatContextPrompt({ messages }, false);

    assert.ok(prompt.includes("id: id-current"), prompt);
    assert.ok(prompt.includes(JSON.stringify(args)), prompt);
    assert.ok(prompt.includes("CURRENT_BODY"), prompt);
    assert.doesNotMatch(prompt, /Tools \(completed\)/);
  });
}

const image = { type: "image", mimeType: "image/png", data: "PRIVATE_BASE64_" + "A".repeat(1_000_000) } as const;
for (const earlier of [false, true]) {
  it(`current result keeps image MIME when text is truncated (earlier=${earlier})`, () => {
    const withImage: Result = { ...result("image-budget"), content: [{ type: "text", text: "x".repeat(30000) }, image] };
    const messages: Message[] = [withImage, ...(earlier ? Array.from({ length: 4 }, (_, index) => result(`new-${index}`, "y".repeat(12000))) : [])];
    const prompt = formatContextPrompt({ messages }, false);
    const body = prompt.split("## Tool result: read (id: image-budget,")[1]!.split("## Tool result:")[0]!;

    assert.ok(body.includes("image/png"));
    assert.ok(body.includes("content unavailable"));
    assert.doesNotMatch(prompt, /PRIVATE_BASE64|data:image/);
    const resultBodies = prompt.split(/## Tool result:[^\n]+\n\n/).slice(1).map((value) => value.replace(/\n\n$/, ""));
    assert.ok(resultBodies.reduce((sum, value) => sum + value.length, 0) <= 24000);
    assert.ok(resultBodies.every((value) => value.length <= 8000));
  });
}
for (const mode of ["completed", "current", "user", "incremental"] as const) {
  it(`completed context: ${mode} images are bounded MIME placeholders with text association`, () => {
    const imageResult: Result = { ...result("id-image"), content: [{ type: "text", text: "IMAGE_ERROR" }, image], isError: true };
    const messages: Message[] = mode === "user" || mode === "incremental"
      ? [{ role: "user", content: [{ type: "text", text: "IMAGE_REQUEST" }, image], timestamp: 1 }]
      : [assistant([call("id-image", "picture.png")]), imageResult, ...(mode === "completed" ? [terminal()] : [])];
    const context: Context = { messages };
    const prompt = mode === "incremental" ? formatContextUpdate(messages, "incremental_conversation") : formatContextPrompt(context, false);

    assert.ok(prompt.length < 5000, `image payload expanded output to ${prompt.length}`);
    assert.doesNotMatch(prompt, /PRIVATE_BASE64|AAAA|data:image/);
    ordered(prompt, [mode === "user" || mode === "incremental" ? "IMAGE_REQUEST" : "IMAGE_ERROR", "image/png"]);
    assert.match(prompt, /Image omitted/);
    if (mode === "completed") ordered(prompt, ["picture.png", "IMAGE_ERROR", "image/png"]);
  });
}
