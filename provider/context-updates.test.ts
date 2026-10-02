import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context, Message } from "@earendil-works/pi-ai";
import { formatContextPrompt } from "./provider.ts";

const format: (context: Context, isReused: boolean, syncedMessageCount?: number) => string = formatContextPrompt;
const oldMessage: Message = { role: "user", content: "OLD_HISTORY_SENTINEL", timestamp: 1 };
const image = { type: "image", mimeType: "image/png", data: "AAECA/8=" } as const;
interface Case {
  name: string;
  context: Context;
  isReused: boolean;
  syncedMessageCount?: number;
  exact?: string;
  includes?: string[];
  excludes?: string[];
}

const incremental = '<pi_context purpose="incremental_conversation">';
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
    includes: [incremental, '<message role="user">\n    <text>first &lt;new&gt;</text>', '<message role="user">\n    <text>second &amp; new</text>'],
    excludes: ["OLD_HISTORY_SENTINEL", "<history", "<current_message"],
  },
  {
    name: "zero synced messages includes the entire new slice",
    context: { messages: [{ role: "system", content: "new rules", timestamp: 1 }, { role: "user", content: "request", timestamp: 2 }] },
    isReused: true, syncedMessageCount: 0,
    includes: [incremental, '<message role="system">', '<text>new rules</text>', '<message role="user">', '<text>request</text>'],
    excludes: ["<history"],
  },
  {
    name: "formats a single new system message as incremental XML",
    context: { messages: [oldMessage, { role: "system", content: "rules & policy", timestamp: 2 }] },
    isReused: true, syncedMessageCount: 1,
    includes: [incremental, '<message role="system">', '<text>rules &amp; policy</text>'],
    excludes: ["OLD_HISTORY_SENTINEL", "<history"],
  },
  ...[true, false].map((isReused): Case => ({
    name: `preserves exact image bytes in ${isReused ? "incremental" : "rebuilt"} XML`,
    context: { messages: [oldMessage, { role: "user", content: [{ type: "text", text: "look" }, image], timestamp: 2 }] },
    isReused, syncedMessageCount: 1,
    includes: [isReused ? incremental : '<pi_context purpose="reconstructed_conversation">', '<image mime_type="image/png" encoding="base64">AAECA/8=</image>'],
    excludes: ["binary content omitted", "[Image:", ...(isReused ? ["OLD_HISTORY_SENTINEL", "<history"] : [])],
  })),
  ...[
    { name: "fully synced history", messages: [oldMessage], syncedMessageCount: 1 },
    { name: "empty context", messages: [], syncedMessageCount: 0 },
  ].map(({ name, messages, syncedMessageCount }): Case => ({
    name: `returns empty output for ${name}`,
    context: { messages }, isReused: true, syncedMessageCount, exact: "",
  })),
];

describe("formatContextPrompt context updates", () => {
  for (const { name, context, isReused, syncedMessageCount, exact, includes = [], excludes = [] } of cases) {
    it(name, () => {
      const prompt = format(context, isReused, syncedMessageCount);

      if (exact !== undefined) assert.equal(prompt, exact);
      for (const fragment of includes) assert.ok(prompt.includes(fragment), `Missing ${fragment} in ${prompt}`);
      for (const fragment of excludes) assert.ok(!prompt.includes(fragment), `Unexpected ${fragment} in ${prompt}`);
    });
  }
});
