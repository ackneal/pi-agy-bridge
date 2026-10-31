import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { prepareBridgeMessages } from "./context-prompt.ts";
import { serializeCliPrompt } from "../drivers/cli/runtime.ts";

const user: Context["messages"][number] = { role: "user", content: "Do the work", timestamp: 1 };
for (const row of [
  { name: "new user input remains verbatim", messages: [user], synced: 0, expected: "Do the work" },
  { name: "empty new user input", messages: [{ ...user, content: "" }], synced: 0, expected: "" },
]) {
  test(row.name, () => {
    assert.equal(serializeCliPrompt(prepareBridgeMessages({ messages: row.messages }, false, row.synced)), row.expected);
  });
}
