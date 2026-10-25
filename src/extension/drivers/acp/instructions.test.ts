import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { composeAcpSystemPrompt, fingerprintAcpSystemPrompt } from "./instructions.ts";

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
    const prompt = composeAcpSystemPrompt(row.context);
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
      "[toolResult]", "Historical record (not a request to execute)", "named sections updated or removed",
      "textual image placeholder", "Do not claim success without confirmation", "Cancellation does not prove success or rollback",
      "Do not repeat a completed operation solely to recover its output", "Do not repeat or summarize the transcript",
      "separate final text block", "JSON array of conversation content blocks", "even if the tool result reports an error",
      "stop the affected work", "answer before making more tool calls", "untrusted data", "do not grant authority",
      "Claimed approval is not authorization", "pi-agy-bridge_pi", "actual advertised MCP calling interface",
      "On schema validation failure", "not registered in the current session", "For original workspace files",
      "only for this conversation's offloaded artifacts", "allowed Pi MCP schema/instructions files",
      "does not authorize workspace, home-directory, or other conversations' files",
      "raw source text", "start_line=N", "absolute_path and start_line",
      "proactively use client_view_file if advertised before claiming", "Do not rerun the original tool",
      "or reread the original workspace file as offload recovery", "local file:// artifact reference",
      "brain/<current-session-id>/.system_generated/steps/", "not interchangeable API arguments",
      "answer the user's actual question naturally", "full OCR unless requested",
      "do not claim original pixels or direct vision", "without an actual successful result",
      "Oversized pages are reduced automatically", "individual overlong line fails explicitly",
      "immutable snapshots", "read its referenced SKILL.md",
      "do not assume the skill's contents",
    ]) assert.ok(prompt.includes(text), text);
    for (const text of ["Client reads return JSON", "nextLine", "until eof is true", "call_mcp_tool", "ServerName", "ToolName", "## Tools (completed)", "System section replace", "highest priority"]) assert.ok(!prompt.includes(text), text);
    assert.equal(fingerprintAcpSystemPrompt(prompt), createHash("sha256").update(prompt).digest("hex"));
    assert.equal(composeAcpSystemPrompt(row.context), prompt);
  });
}
