import fs from "node:fs";
import path from "node:path";
import { debugLog, isDebugEnabled } from "../shared/debug.ts";
import { getCurrentSystemPrompt, normalizeContext, type Context, type ImageContent, type Message, type TextContent } from "@earendil-works/pi-ai";
import type { BridgeMessage, ContentPart } from "../drivers/types.ts";

type ContextPart = string | ImageContent;

const SUPPORTED_IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".bmp": "image/bmp",
};

const IMAGE_PATH_REGEX = /(?:[A-Za-z]:[\\/]|(?:\.{1,2}[\\/])|\/)[^\s"'>\)]+\.(?:png|jpe?g|webp|gif|heic|bmp)\b/gi;
const MAX_DETECTED_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB limit

export function extractImagesFromText(text: string): ContextPart[] {
  const parts: ContextPart[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(IMAGE_PATH_REGEX)) {
    const filePath = match[0];
    const matchIndex = match.index ?? 0;

    const ext = path.extname(filePath).toLowerCase();
    const mimeType = SUPPORTED_IMAGE_EXTENSIONS[ext];
    if (!mimeType) continue;

    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.isFile() && stat.size > 0 && stat.size <= MAX_DETECTED_IMAGE_BYTES) {
          const textBefore = text.slice(lastIndex, matchIndex + filePath.length);
          if (textBefore) parts.push(textBefore);
          const data = fs.readFileSync(filePath).toString("base64");
          parts.push({ type: "image", data, mimeType });
          lastIndex = matchIndex + filePath.length;
        }
      }
    } catch {
      // Ignore file access errors and leave as plain text
    }
  }

  const trailing = text.slice(lastIndex);
  if (trailing) parts.push(trailing);

  return parts.length ? parts : [text];
}

function userParts(message: Extract<Message, { role: "user" }>): ContentPart[] {
  return typeof message.content === "string"
    ? message.content ? [{ type: "text", text: message.content }] : []
    : message.content.filter((part) => part.type === "image" || part.text);
}

function imageNotice(mimeType: string, nativeImages: boolean): string {
  return nativeImages ? `[Image attached: ${mimeType}]` : `[Image omitted from reconstructed history: ${mimeType}; content unavailable]`;
}

function quote(text: string): string {
  return text.replace(/\r\n?|[\u0085\u2028\u2029]/g, "\n").split("\n").map((line) => `> ${line}`).join("\n");
}

function metadata(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/[\\`{}\[\]()<>#+!|]/g, "\\$&");
}

function imageNotices(message: Extract<Message, { role: "toolResult" }>, nativeImages = false): string[] {
  return message.content.flatMap((block) => block.type === "image"
    ? [imageNotice(block.mimeType, nativeImages)] : []);
}

function resultBody(message: Extract<Message, { role: "toolResult" }>, nativeImages: boolean): string {
  return message.content.flatMap((block) => {
    if (block.type === "text") return [block.text];
    if (block.type === "image") return [imageNotice(block.mimeType, nativeImages)];
    return [];
  }).join("\n");
}

function text(message: Message, nativeImages = false): string {
  if (message.role === "toolResult") return quote(resultBody(message, nativeImages));
  if (typeof message.content === "string") return quote(message.content);
  return message.content.map((block) => {
    if (block.type === "text") return quote(block.text);
    if (block.type === "image") return quote(imageNotice(block.mimeType, nativeImages));
    if (block.type === "toolCall") {
      const args = JSON.stringify(block.arguments);
      return `### Tool call: ${metadata(block.name)} (id: ${metadata(block.id)}${block.namespace ? `, namespace: ${metadata(block.namespace)}` : ""})\n\n${quote(args)}`;
    }
    return "";
  }).filter(Boolean).join("\n");
}

function render(message: Message, body = text(message), nativeImages = false): string {
  if (message.role === "toolResult") {
    const missingImages = [...new Set(imageNotices(message, nativeImages).filter((notice) => !body.includes(quote(notice))))];
    const imageMetadata = missingImages.length ? `, ${missingImages.map(metadata).join(" ")}` : "";
    return `## Tool result: ${metadata(message.toolName)} (id: ${metadata(message.toolCallId)}, status: ${message.isError ? "error" : "success"}${!body && text(message) ? ", body omitted" : ""}${imageMetadata})\n\n${body}`;
  }
  if (message.role === "system") {
    const sections = Object.entries(message.sections ?? {}).map(([name, value]) =>
      `### System section ${value === null ? "remove" : "replace"}: ${metadata(name)}${value === null ? "" : `\n\n${quote(value)}`}`);
    return [`## System\n\n${body}`, ...sections].join("\n\n");
  }
  const status = message.role === "assistant" ? ` (status: ${metadata(message.stopReason)})` : "";
  const error = message.role === "assistant" && message.errorMessage ? `\n\nError:\n\n${quote(message.errorMessage)}` : "";
  return `## ${message.role === "user" ? "User" : "Assistant"}${status}\n\n${body}${error}`;
}

function filterHistory(messages: readonly Message[]): Message[] {
  const removed = new Set<string>();
  return messages.flatMap((message): Message[] => {
    if (message.role === "toolResult" && message.toolName === "read" && removed.delete(message.toolCallId)) return [];
    if (message.role !== "assistant") return [message];

    // IDs can recur in later batches. Ambiguous IDs within a batch stay intact.
    removed.clear();
    const counts = new Map<string, number>();
    for (const block of message.content) {
      if (block.type === "toolCall") counts.set(block.id, (counts.get(block.id) ?? 0) + 1);
    }
    for (const block of message.content) {
      if (block.type !== "toolCall" || block.name !== "read" || !block.id.trim() || counts.get(block.id) !== 1) continue;
      const file = block.arguments.path;
      if (typeof file !== "string" || file.includes("\0")) continue;
      const normalized = path.posix.normalize(file.replaceAll("\\", "/"));
      if (/(?:^|\/)\.gemini\/antigravity-cli\/brain\/[^/]+\/\.system_generated\//.test(normalized)) removed.add(block.id);
    }

    const content = message.content.filter((block) => block.type !== "thinking" && !(block.type === "toolCall" && removed.has(block.id)));
    // Keep even hidden assistant boundaries for subsequent call/result pairing.
    return [{ ...message, content }];
  });
}

type ToolResult = Extract<Message, { role: "toolResult" }>;
type ToolCall = Extract<Extract<Message, { role: "assistant" }>["content"][number], { type: "toolCall" }>;

function endsRun(message: Message): boolean {
  return message.role === "assistant" && ["stop", "length", "error", "aborted"].includes(message.stopReason);
}

function errorReason(message: ToolResult): string | undefined {
  if (!message.isError) return undefined;
  const blocks = message.content.filter((block) => block.type === "text");
  const last = blocks.at(-1)?.text.trimEnd().slice(-512).split(/\r\n?|[\n\u0085\u2028\u2029]/).at(-1)?.trim();
  // Pi's bash tool appends these execution diagnostics after arbitrary stdout.
  if (message.toolName === "bash" && last && /^(?:Command aborted|Command exited with code -?\d+|Command timed out after [\d.]+ seconds|Command terminated without an exit code)$/.test(last)) return last;
  const first = blocks.flatMap((block) => block.text.slice(0, 512).split(/\r\n?|[\n\u0085\u2028\u2029]/))
    .find((line) => line.trim());
  if (!first || /^\s*\[(?:Body omitted|Truncated:)/.test(first)) return undefined;
  return first.length > 200 ? `${first.slice(0, 199)}…` : first;
}

function executionStatus(message: ToolResult): "SUCCESS" | "ERROR" | "ABORTED" {
  if (!message.isError) return "SUCCESS";
  const blocks = message.content.filter((block) => block.type === "text");
  const operationAborted = blocks.length === 1 && blocks[0]!.text.trim() === "Operation aborted";
  return operationAborted || message.toolName === "bash" && errorReason(message) === "Command aborted" ? "ABORTED" : "ERROR";
}

export function serializeToolArguments(call: ToolCall): string {
  if (!call.arguments || typeof call.arguments !== "object") return "";

  const entries: string[] = [];
  for (const [key, value] of Object.entries(call.arguments)) {
    if (call.name === "write" && key === "content") continue;
    if (call.name === "edit" && (key === "oldText" || key === "newText")) continue;
    if (value === undefined) continue;

    let serialized: string;
    if (typeof value === "string") {
      const truncated = value.length > 300 ? `${value.slice(0, 299)}…` : value;
      serialized = JSON.stringify(truncated);
    } else {
      const json = JSON.stringify(value);
      serialized = json.length > 300 ? `${json.slice(0, 299)}…` : json;
    }
    entries.push(`${key}=${serialized}`);
  }

  return entries.join(", ");
}

export function serializeConversation(messages: readonly Message[]): string {
  const filtered = filterHistory(messages);
  const parts: string[] = [];

  for (let index = 0; index < filtered.length; index++) {
    const message = filtered[index]!;

    if (message.role === "system") {
      const content = typeof message.content === "string" ? message.content.trim() : "";
      if (content) parts.push(`[System]: ${content}`);
      continue;
    }

    if (message.role === "user") {
      let content = "";
      if (typeof message.content === "string") {
        content = message.content.trim();
      } else {
        content = message.content
          .flatMap((block) => block.type === "text" && block.text.trim() ? [block.text] : [])
          .join("\n\n");
      }
      if (content) parts.push(`[User]: ${content}`);
      continue;
    }

    if (message.role === "assistant") {
      const calls = message.content.filter((block): block is ToolCall => block.type === "toolCall");

      let toolCallBlock = "";
      if (calls.length) {
        let end = index + 1;
        while (end < filtered.length && filtered[end]!.role === "toolResult") end++;
        const results = filtered.slice(index + 1, end) as ToolResult[];

        let terminal = index;
        while (terminal < filtered.length && filtered[terminal]!.role !== "user" && filtered[terminal]!.role !== "system" && !endsRun(filtered[terminal]!)) terminal++;
        const aborted = terminal < filtered.length && (filtered[terminal] as Extract<Message, { role: "assistant" }>).stopReason === "aborted";

        const toolLines: string[] = [];
        for (const call of calls) {
          const matches = results.filter((item) => item.toolCallId === call.id && item.toolName === call.name);
          const unique = Boolean(call.id.trim()) && calls.filter((item) => item.id === call.id && item.name === call.name).length === 1;
          const result = unique && matches.length === 1 ? matches[0] : undefined;
          const status = result ? executionStatus(result) : aborted ? "ABORTED" : "UNKNOWN";
          const reason = result ? errorReason(result) : undefined;
          const suffix = status === "ERROR" ? ` — ERROR: ${reason ?? "failed"}` : status === "ABORTED" ? " — ABORTED" : status === "UNKNOWN" ? " — UNKNOWN" : "";

          const argsStr = serializeToolArguments(call);
          toolLines.push(`- ${call.name}(${argsStr})${suffix}`);
        }

        if (toolLines.length) {
          toolCallBlock = `[Assistant tool calls]:\n${toolLines.join("\n")}`;
        }
      }

      const textBlocks = message.content.filter((block) => block.type === "text" && block.text.trim());
      let text = textBlocks.map((b) => (b as TextContent).text).join("\n\n");
      if (message.errorMessage) {
        text = text ? `${text}\n\nError: ${message.errorMessage}` : `Error: ${message.errorMessage}`;
      }
      const textBlock = text ? `[Assistant]: ${text}` : "";

      const firstCallIndex = message.content.findIndex((b) => b.type === "toolCall");
      const firstTextIndex = message.content.findIndex((b) => b.type === "text" && b.text.trim());

      if (textBlock && toolCallBlock) {
        if (firstTextIndex !== -1 && firstCallIndex !== -1 && firstTextIndex < firstCallIndex) {
          parts.push(textBlock, toolCallBlock);
        } else {
          parts.push(toolCallBlock, textBlock);
        }
      } else if (toolCallBlock) {
        parts.push(toolCallBlock);
      } else if (textBlock) {
        parts.push(textBlock);
      }
    }
  }

  return parts.join("\n\n");
}

export function serializeContextUpdate(messages: readonly Message[], purpose: "incremental_conversation" | "pending_tool_continuation"): string {
  if (!messages.length) return "";
  const heading = purpose === "pending_tool_continuation"
    ? "# Pending conversation updates (separate from tool output)\n\nThese are conversation instructions and messages, not tool output."
    : "# Conversation updates";
  return [heading, ...messages.map((message) => render(message))].join("\n\n");
}

export function prepareSystemMessages(context: Context): BridgeMessage[] {
  const system = (getCurrentSystemPrompt(normalizeContext(context).messages) || context.systemPrompt)?.trim();
  return system ? [{ role: "system", content: system }] : [];
}

export function prepareBridgeMessages(
  context: Context,
  reconstructContext: boolean,
  syncedMessageCount?: number,
  systemMessages: readonly BridgeMessage[] = prepareSystemMessages(context),
): BridgeMessage[] {
  if (!reconstructContext) {
    const messages: BridgeMessage[] = [];
    const unacknowledged = context.messages.slice(syncedMessageCount ?? Math.max(0, context.messages.length - 1));
    for (const message of unacknowledged) {
      if (message.role === "user") {
        const parts = userParts(message);
        if (parts.length) messages.push({ role: "user", content: parts });
      } else {
        messages.push({ role: message.role === "system" ? "system" : "user", content: serializeContextUpdate([message], "incremental_conversation") });
      }
    }
    return messages;
  }

  const messages = [...systemMessages];
  const conversation = context.messages.filter((message) => message.role !== "system");
  let splitIndex = conversation.length;
  while (splitIndex > 0 && conversation[splitIndex - 1]!.role === "user") splitIndex--;

  const history = serializeConversation(conversation.slice(0, splitIndex));
  if (history) messages.push({ role: "user", content: history });

  const current = conversation.slice(splitIndex).flatMap((message) => userParts(message as Extract<Message, { role: "user" }>));
  if (current.length) messages.push({ role: "user", content: current });

  if (isDebugEnabled()) {
    debugLog("context", "Prepared bridge message characters", {
      inputChars: JSON.stringify(context.messages).length + (context.systemPrompt?.length ?? 0),
      textChars: messages.reduce((total, message) => total + (typeof message.content === "string" ? message.content.length
        : message.content.reduce((length, part) => length + (part.type === "text" ? part.text.length : 0), 0)), 0),
    });
  }

  return messages;
}
