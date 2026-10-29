import path from "node:path";
import { debugLog, isDebugEnabled } from "../shared/debug.ts";
import type { Context, ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

// Character budgets apply only to reconstructed result bodies, never live delivery.
export const RESULT_BODY_BUDGET = 24_000;
export const RESULT_BODY_CEILING = 8_000;
export const OLD_CALL_ARGUMENT_LIMIT = 1_000;

const OMITTED_BODY = "[Body omitted]";
type ContextPart = string | ImageContent;

function imageNotice(mimeType: string, nativeImages: boolean): string {
  return nativeImages ? `[Image attached: ${mimeType}]` : `[Image omitted from reconstructed history: ${mimeType}; content unavailable]`;
}

function quote(text: string): string {
  return text.replace(/\r\n?|[\u0085\u2028\u2029]/g, "\n").split("\n").map((line) => `> ${line}`).join("\n");
}

function metadata(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/[\\`{}\[\]()<>#+!|]/g, "\\$&");
}

function limit(text: string, size: number): string {
  const full = quote(text);
  if (full.length <= size) return full;
  const marker = `\n[Truncated: ${text.length} characters total]`;
  if (quote(marker).length > size) return quote(OMITTED_BODY).length <= size ? quote(OMITTED_BODY) : "";

  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (quote(text.slice(0, middle) + marker).length <= size) low = middle;
    else high = middle - 1;
  }
  return quote(text.slice(0, low) + marker);
}

function imageNotices(message: Extract<Message, { role: "toolResult" }>, nativeImages = false): string[] {
  return message.content.flatMap((block) => block.type === "image"
    ? [imageNotice(block.mimeType, nativeImages)] : []);
}

function minimumResultBody(message: Extract<Message, { role: "toolResult" }>, nativeImages: boolean): number {
  const notices = imageNotices(message, nativeImages);
  if (!notices.length) return quote(OMITTED_BODY).length;
  const hasText = message.content.some((block) => block.type === "text" && block.text);
  return quote(notices.join("\n")).length + (hasText ? 1 + quote(OMITTED_BODY).length : 0);
}

function budgetResult(message: Extract<Message, { role: "toolResult" }>, size: number, nativeImages: boolean): string {
  const full = text(message, nativeImages);
  if (full.length <= size) return full;
  const notices = imageNotices(message, nativeImages);
  if (!notices.length || minimumResultBody(message, nativeImages) > size) return limit(resultBody(message, nativeImages), size);

  const images = quote(notices.join("\n"));
  const body = message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
  return body ? `${limit(body, size - images.length - 1)}\n${images}` : images;
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
    // If the body budget cannot fit an image notice, retain it as result metadata.
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

function renderParts(message: Message, body: string, nativeImages: boolean): ContextPart[] {
  if (!nativeImages || typeof message.content === "string" || !message.content.some((block) => block.type === "image")) {
    return [render(message, body, nativeImages)];
  }

  // Keep native images between their surrounding text, not at the end of a message.
  const parts: ContextPart[] = [render({ ...message, content: [] }, "", true).trimEnd()];
  let remaining = body === text(message, true) ? Infinity : body.length;
  let reservedImages = message.content.reduce((sum, block) => block.type === "image" ? sum + quote(imageNotice(block.mimeType, true)).length + 1 : sum, 0);
  let omittedText = false;
  for (const block of message.content) {
    if (block.type === "text") {
      const value = limit(block.text, Math.max(0, remaining - reservedImages));
      if (value) parts.push(value);
      else if (block.text) omittedText = true;
      remaining -= value.length + 1;
    }
    if (block.type === "image") {
      const notice = quote(imageNotice(block.mimeType, true));
      reservedImages -= notice.length + 1;
      remaining -= notice.length + 1;
      parts.push(notice, block);
    }
  }
  if (omittedText) parts[0] += "\n\n> [Some text omitted from reconstructed history]";
  return parts;
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

function operationArguments(call: ToolCall): string {
  const value = ["read", "edit", "write"].includes(call.name) ? call.arguments.path
    : call.name === "bash" ? call.arguments.command : JSON.stringify(call.arguments);
  return typeof value === "string" ? value : "Arguments unavailable";
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

function completedHistory(messages: readonly Message[]): ContextPart[] {
  const output: ContextPart[] = [];
  let group: string | undefined;
  const consumed = new Set<Message>();
  const operation = (name: string, value: string, status: string, result?: ToolResult) => {
    if (!group) output.push("## Tools (completed)");
    if (group !== name) output.push(`${metadata(name)}:`);
    const reason = result ? errorReason(result) : undefined;
    const suffix = status === "SUCCESS" ? "" : ` — ${status}${reason ? `: ${reason}` : ""}`;
    output.push(limit(value, OLD_CALL_ARGUMENT_LIMIT).replace(/^> /, "> - ") + (suffix ? quote(suffix).slice(2) : ""));
    if (result) {
      for (const block of result.content) {
        if (block.type === "image") output.push(quote(imageNotice(block.mimeType, false)));
      }
    }
    group = name;
  };
  const breakGroup = () => { group = undefined; };

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "toolResult") {
      if (consumed.has(message)) continue;
      operation(message.toolName, "Unpaired result", message.isError ? executionStatus(message) : "UNKNOWN", message);
      continue;
    }
    if (message.role !== "assistant") {
      breakGroup();
      output.push(...renderParts(message, text(message, false), false));
      continue;
    }
    const batch = message;
    const calls = batch.content.filter((block): block is ToolCall => block.type === "toolCall");
    if (!calls.length) {
      if (endsRun(batch) || batch.errorMessage || batch.content.some((block) => block.type === "text" && block.text.trim())) {
        breakGroup();
        output.push(render(batch));
      }
      continue;
    }
    let end = index + 1;
    while (end < messages.length && messages[end]!.role === "toolResult") end++;
    const results = messages.slice(index + 1, end) as ToolResult[];
    let terminal = index;
    while (terminal < messages.length && messages[terminal]!.role !== "user" && messages[terminal]!.role !== "system" && !endsRun(messages[terminal]!)) terminal++;
    const aborted = terminal < messages.length && (messages[terminal] as Extract<Message, { role: "assistant" }>).stopReason === "aborted";
    for (const block of batch.content) {
      if (block.type === "text" && block.text.trim()) {
        breakGroup();
        const { errorMessage: _error, ...withoutError } = batch;
        output.push(render({ ...withoutError, content: [block] }));
      }
      if (block.type !== "toolCall") continue;
      const matches = results.filter((item) => item.toolCallId === block.id && item.toolName === block.name);
      const unique = Boolean(block.id.trim()) && calls.filter((item) => item.id === block.id && item.name === block.name).length === 1;
      const result = unique && matches.length === 1 ? matches[0] : undefined;
      if (result) consumed.add(result);
      const status = result ? executionStatus(result) : unique && !matches.length && aborted ? "ABORTED: completion unknown" : "UNKNOWN";
      operation(block.name, operationArguments(block), status, result);
    }
    if (endsRun(batch)) breakGroup();
    if (batch.errorMessage || endsRun(batch) && !batch.content.some((block) => block.type === "text" && block.text.trim())) {
      breakGroup();
      output.push(render({ ...batch, content: [] }));
    }
  }
  return output;
}

export function formatContextUpdate(messages: readonly Message[], purpose: "incremental_conversation" | "pending_tool_continuation"): string {
  if (!messages.length) return "";
  const heading = purpose === "pending_tool_continuation"
    ? "# Pending conversation updates (separate from tool output)\n\nThese are conversation instructions and messages, not tool output."
    : "# Conversation updates";
  return [heading, ...messages.map((message) => render(message))].join("\n\n");
}

function contextParts(context: Context, isReused: boolean, syncedMessageCount: number | undefined, nativeImages: boolean): ContextPart[] {
  if (isReused) {
    const messages = context.messages.slice(syncedMessageCount ?? Math.max(0, context.messages.length - 1));
    const only = messages[0];
    if (messages.length === 1 && only?.role === "user" &&
      (typeof only.content === "string" || only.content.every((block) => block.type === "text"))) return [typeof only.content === "string" ? only.content : only.content.map((block) => block.type === "text" ? block.text : "").join("\n")];
    return messages.length ? ["# Conversation updates", ...messages.flatMap((message) => renderParts(message, text(message, nativeImages), nativeImages))] : [];
  }

  // Determine run boundaries before filtering empty assistant messages.
  let start = 0;
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i];
    if (message && endsRun(message)) { start = i + 1; break; }
  }
  const oldMessages = filterHistory(context.messages.slice(0, start));
  const currentMessages = filterHistory(context.messages.slice(start));
  const results = currentMessages.filter((message): message is ToolResult => message.role === "toolResult");
  const bodies = new Map<Message, string>();
  const total = results.reduce((sum, message) => sum + text(message, nativeImages).length, 0);
  let remaining = RESULT_BODY_BUDGET;
  const prioritized = [...results].reverse().sort((a, b) => Number(b.isError) - Number(a.isError));
  let reservedMinimum = prioritized.reduce((sum, message) => sum + minimumResultBody(message, nativeImages), 0);
  for (const message of prioritized) {
    const body = text(message, nativeImages);
    reservedMinimum -= minimumResultBody(message, nativeImages);
    const reserved = Math.min(remaining, reservedMinimum);
    const size = total <= RESULT_BODY_BUDGET ? body.length : Math.min(remaining - reserved, RESULT_BODY_CEILING, body.length);
    const rendered = budgetResult(message, size, nativeImages);
    bodies.set(message, rendered);
    remaining -= rendered.length;
  }

  const parts: ContextPart[] = [context.systemPrompt ? `# System prompt\n\n${quote(context.systemPrompt)}` : "",
    oldMessages.length + currentMessages.length > 1
      ? "# Conversation history\n\nThese messages restore prior conversation state. Do not repeat completed actions. Continue unfinished work, respecting later corrections and cancellations."
      : "",
    ...completedHistory(oldMessages),
    ...currentMessages.filter((message) => message.role !== "assistant" || message.content.length || message.errorMessage || endsRun(message))
      .flatMap((message) => renderParts(message, bodies.get(message) ?? text(message, nativeImages), nativeImages))].filter(Boolean);

  if (isDebugEnabled()) {
    // Baseline: original JSON message representation plus raw system prompt, in UTF-16 characters.
    const changedResults = [...bodies].filter(([message, body]) => body !== text(message, nativeImages));
    const omittedResults = changedResults.filter(([, body]) => !body || body === quote(OMITTED_BODY) || body.startsWith(`${quote(OMITTED_BODY)}\n`));
    debugLog("context", "Rebuild representation characters", {
      inputChars: JSON.stringify(context.messages).length + (context.systemPrompt?.length ?? 0),
      finalChars: parts.filter((part) => typeof part === "string").join("\n\n").length,
      omittedToolResults: context.messages.filter((message) => message.role === "toolResult").length - results.length + omittedResults.length,
      truncatedToolResults: changedResults.length - omittedResults.length,
      truncatedArguments: oldMessages.flatMap((message) => message.role === "assistant" ? message.content : []).filter((block) => {
        if (block.type !== "toolCall") return false;
        return quote(operationArguments(block)).length > OLD_CALL_ARGUMENT_LIMIT;
      }).length,
      imagePlaceholders: [...oldMessages, ...currentMessages].reduce((sum, message) => sum +
        (typeof message.content === "string" ? 0 : message.content.filter((block) => block.type === "image").length), 0),
    });
  }
  return parts;
}

export function formatContextPrompt(context: Context, isReused: boolean, syncedMessageCount?: number): string {
  return contextParts(context, isReused, syncedMessageCount, false).join("\n\n");
}

export function formatContextBlocks(context: Context, isReused: boolean, syncedMessageCount?: number): (TextContent | ImageContent)[] {
  const blocks: (TextContent | ImageContent)[] = [];
  let paragraphs: string[] = [];
  const flush = () => {
    if (paragraphs.length) blocks.push({ type: "text", text: paragraphs.join("\n\n") });
    paragraphs = [];
  };
  for (const part of contextParts(context, isReused, syncedMessageCount, true)) {
    if (typeof part === "string") paragraphs.push(part);
    else {
      flush();
      blocks.push(part);
    }
  }
  flush();
  return blocks;
}
