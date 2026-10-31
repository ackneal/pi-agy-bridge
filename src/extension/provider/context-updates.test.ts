import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context, Message } from "@earendil-works/pi-ai";
import { prepareBridgeMessages } from "./context-prompt.ts";
import { serializePrompt } from "../drivers/cli/runtime.ts";

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
