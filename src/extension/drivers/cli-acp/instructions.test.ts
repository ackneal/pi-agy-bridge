import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { composeSystemPrompt, fingerprintSystemPrompt, integrationInstructions } from "./instructions.ts";
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

    assert.ok(prompt.startsWith("You are the model runtime delegated by Pi."));
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
