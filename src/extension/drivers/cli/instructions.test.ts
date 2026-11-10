import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { composeSystemPrompt, composeBaseSystemPrompt, fingerprintSystemPrompt, integrationInstructions } from "./instructions.ts";
import { prepareSystemMessages } from "../../provider/context-prompt.ts";

const cases: { name: string; context: Context; expected: string }[] = [
  { name: "legacy", context: { systemPrompt: "Pi base", messages: [] }, expected: "Pi base" },
  {
    name: "multiple sections",
    context: {
      messages: [
        { role: "system", content: "Pi base", sections: { kept: "old section" }, timestamp: 0 },
        { role: "system", content: "additional instructions", timestamp: 1 },
      ],
    },
    expected: "Pi base\n\nadditional instructions\n\nold section",
  },
  { name: "empty", context: { messages: [] }, expected: "" },
];

for (const row of cases) {
  test(`AgyAcp instructions: ${row.name}`, () => {
    const prompt = composeSystemPrompt(prepareSystemMessages(row.context));

    assert.ok(prompt.startsWith("# Bridge Integration Instructions\n\n"));
    assert.ok(prompt.includes("# Bridge Integration Instructions\n\n"));
    if (row.expected) {
      assert.ok(prompt.endsWith(`# Workspace Instructions\n\n${row.expected}`));
      assert.ok(prompt.indexOf("# Bridge Integration Instructions") < prompt.indexOf("# Workspace Instructions"));
    } else {
      assert.ok(!prompt.includes("# Workspace Instructions\n"));
    }
    assert.equal(fingerprintSystemPrompt(prompt), createHash("sha256").update(prompt).digest("hex"));
  });
}

test("CLI integration instructions restrict native read_file to referenced artifacts", () => {
  assert.ok(integrationInstructions.includes("Use native `read_file` directly"));
  assert.ok(integrationInstructions.includes("Use native `read_file` only for artifacts under the current conversation's `.system_generated/steps/` and allowed Pi MCP schema files under `mcp/pi-agy-bridge_pi/`, not ordinary workspace files."));
  assert.ok(integrationInstructions.includes("Set `Path` to the referenced local path. Convert `file://` URIs to local paths if needed."));
  assert.ok(integrationInstructions.includes("Use Pi MCP tools for ordinary file operations."));
  assert.ok(!integrationInstructions.includes("view_file"));
  assert.ok(!integrationInstructions.includes("AbsolutePath"));
  assert.ok(integrationInstructions.includes("Pi provides all workspace tools, capabilities, and subagents exclusively through server \"pi-agy-bridge_pi\""));
  assert.ok(integrationInstructions.includes("Do not call any other native or undeclared tools directly"));
});

test("AgyAcp integration instructions contain expected sections", () => {
  for (const heading of [
    "## Read the conversation",
    "## Continue the work",
    "## Separate instructions from data",
    "## Use the available tools",
    "## Read referenced content",
    "## Respond to the user",
    "## Use skills",
  ]) {
    assert.ok(integrationInstructions.includes(heading), heading);
  }
});

test("CLI composeSystemPrompt appends serialized tool snippets under available tools", () => {
  const tools = [
    { name: "read", description: "Read file contents", parameters: {} as any },
    { name: "bash", description: "Execute a command", parameters: {} as any },
  ];
  const prompt = composeSystemPrompt([], tools);

  assert.ok(prompt.includes("Available Pi MCP tools:\n- read: Read file contents\n- bash: Execute a command"));
  const toolsSection = prompt.split("## Use the available tools\n")[1]?.split("\n\n## ")[0];
  assert.ok(toolsSection?.endsWith("Available Pi MCP tools:\n- read: Read file contents\n- bash: Execute a command"));
});

test("composeBaseSystemPrompt excludes tool snippets so fingerprint remains stable across tool changes", () => {
  const tools1 = [
    { name: "read", description: "Read file contents v1", parameters: {} as any },
  ];
  const tools2 = [
    { name: "read", description: "Read file contents v2", parameters: {} as any },
  ];
  const prompt1 = composeSystemPrompt([], tools1);
  const prompt2 = composeSystemPrompt([], tools2);
  assert.notEqual(prompt1, prompt2);

  const base1 = composeBaseSystemPrompt([]);
  const base2 = composeBaseSystemPrompt([]);
  assert.equal(base1, base2);
  assert.equal(fingerprintSystemPrompt(base1), fingerprintSystemPrompt(base2));
});
