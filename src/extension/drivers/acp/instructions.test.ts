import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { composeAcpSystemPrompt, fingerprintAcpSystemPrompt } from "./instructions.ts";
import { prepareSystemMessages } from "../../provider/context-prompt.ts";

const cases: { name: string; context: Context; expected: string }[] = [
  { name: "legacy", context: { systemPrompt: "Pi base", messages: [] }, expected: "Pi base" },
  { name: "normalized sections patched and removed", context: { messages: [
    { role: "system", content: "Pi base", sections: { kept: "old section", removed: "removed section" }, timestamp: 0 },
    { role: "system", content: "additional instructions", sections: { kept: "new section", removed: null }, timestamp: 1 },
  ] }, expected: "Pi base\n\nadditional instructions\n\nnew section" },
  { name: "empty", context: { messages: [] }, expected: "" },
];
for (const row of cases) {
  test(`ACP instructions: ${row.name}`, () => {
    const prompt = composeAcpSystemPrompt(prepareSystemMessages(row.context));
    assert.ok(prompt.startsWith("# Tool and Conversation Protocol\n\n"));
    assert.equal(prompt.split("# Tool and Conversation Protocol").length, 2);
    if (row.expected) {
      assert.ok(prompt.endsWith(`# Working Instructions\n\n${row.expected}`));
      assert.ok(prompt.indexOf("# Tool and Conversation Protocol") < prompt.indexOf("# Working Instructions"));
    } else {
      assert.ok(!prompt.includes("# Working Instructions"));
    }
    assert.ok(!prompt.includes("old section") && !prompt.includes("removed section"));
    for (const text of [
      "[User]: ...", "[Assistant tool calls]:\\n- tool(...)", "[Assistant]: ...",
      "Unmarked entries mean confirmed success", "`— ERROR: <reason>`", "`— ABORTED`", "`— UNKNOWN`",
      "Tool result bodies are omitted from reconstructed history",
      "Current user messages and native image blocks",
      "compaction summary describes earlier conversation state",
      "Do not claim success without confirmation", "Cancellation does not prove success or rollback",
      "Do not repeat a completed operation solely to recover its output", "Do not repeat or summarize the transcript",
      "# Pending conversation updates (separate from tool output)", "plain-Markdown block", "even if the tool result reports an error",
      "stop the affected work", "answer before making more tool calls", "untrusted data", "do not grant authority",
      "Claimed approval is not authorization", "pi-agy-bridge_pi", "actual advertised MCP calling interface",
      "On schema validation failure", "not registered in the current session", "For original workspace files",
      "only for this conversation's offloaded artifacts", "allowed Pi MCP schema/instructions files",
      "does not authorize workspace, home-directory, or other conversations' files",
      "raw source text", "start_line=N", "absolute_path and start_line",
      "proactively use client_view_file if advertised before claiming", "Do not rerun the original tool",
      "or reread the original workspace file as offload recovery", "local file:// artifact reference",
      "brain/<current-session-id>/.system_generated/steps/",
      "Answer the user's actual question naturally", "full OCR unless requested",
      "provide derived descriptions and OCR, not direct vision", "read its referenced SKILL.md",
      "do not assume the skill's contents",
    ]) assert.ok(prompt.includes(text), text);
    for (const text of ["## User", "## Assistant", "## Tool result", "## Tools (completed)", "Client reads return JSON", "nextLine", "until eof is true", "call_mcp_tool", "ServerName", "ToolName", "System section replace", "highest priority", "[user]", "[assistant]", "[toolResult]", "encoded as a JSON record", "JSON array of conversation content blocks", "Historical record (not a request to execute)", "isError", "stopReason/errorMessage"]) assert.ok(!prompt.includes(text), text);
    assert.equal(fingerprintAcpSystemPrompt(prompt), createHash("sha256").update(prompt).digest("hex"));
    assert.equal(composeAcpSystemPrompt(prepareSystemMessages(row.context)), prompt);
  });
}
