import path from "node:path";
import type { Context, Message } from "@earendil-works/pi-ai";

// Character budgets apply only to reconstructed result bodies, never live delivery.
export const RESULT_BODY_BUDGET = 24_000;
export const RESULT_BODY_CEILING = 8_000;
export const OLD_CALL_ARGUMENT_LIMIT = 1_000;

const OMITTED_BODY = "[Body omitted]";

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

function resultBody(message: Extract<Message, { role: "toolResult" }>): string {
  return message.content.flatMap((block) => {
    if (block.type === "text") return [block.text];
    if (block.type === "image") return [`![Image](data:${block.mimeType};base64,${block.data})`];
    return [];
  }).join("\n");
}

function text(message: Message, old = false): string {
  if (message.role === "toolResult") return quote(resultBody(message));
  if (typeof message.content === "string") return quote(message.content);
  return message.content.map((block) => {
    if (block.type === "text") return quote(block.text);
    if (block.type === "image") return quote(`![Image](data:${block.mimeType};base64,${block.data})`);
    if (block.type === "toolCall") {
      const args = JSON.stringify(block.arguments);
      return `### Tool call: ${metadata(block.name)} (id: ${metadata(block.id)}${block.namespace ? `, namespace: ${metadata(block.namespace)}` : ""})\n\n${old ? limit(args, OLD_CALL_ARGUMENT_LIMIT) : quote(args)}`;
    }
    return "";
  }).filter(Boolean).join("\n");
}

function render(message: Message, body = text(message)): string {
  if (message.role === "toolResult") {
    return `## Tool result: ${metadata(message.toolName)} (id: ${metadata(message.toolCallId)}, status: ${message.isError ? "error" : "success"}${!body && text(message) ? ", body omitted" : ""})\n\n${body}`;
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
      if (block.type !== "toolCall" || block.name !== "read" || counts.get(block.id) !== 1) continue;
      const file = block.arguments.path;
      if (typeof file !== "string" || file.includes("\0")) continue;
      const normalized = path.posix.normalize(file.replaceAll("\\", "/"));
      if (/(?:^|\/)\.gemini\/antigravity-cli\/brain\/[^/]+\/\.system_generated\//.test(normalized)) removed.add(block.id);
    }

    const content = message.content.filter((block) => block.type !== "thinking" && !(block.type === "toolCall" && removed.has(block.id)));
    if (!content.length && !message.errorMessage) return [];
    return [{ ...message, content }];
  });
}

export function formatContextUpdate(messages: readonly Message[], purpose: "incremental_conversation" | "pending_tool_continuation"): string {
  if (!messages.length) return "";
  const heading = purpose === "pending_tool_continuation"
    ? "# Pending conversation updates (separate from tool output)\n\nThese are conversation instructions and messages, not tool output."
    : "# Conversation updates";
  return [heading, ...messages.map((message) => render(message))].join("\n\n");
}

export function formatContextPrompt(context: Context, isReused: boolean, syncedMessageCount?: number): string {
  if (isReused) {
    const messages = context.messages.slice(syncedMessageCount ?? Math.max(0, context.messages.length - 1));
    const only = messages[0];
    if (messages.length === 1 && only?.role === "user" &&
      (typeof only.content === "string" || only.content.every((block) => block.type === "text"))) return typeof only.content === "string" ? only.content : only.content.map((block) => block.type === "text" ? block.text : "").join("\n");
    return formatContextUpdate(messages, "incremental_conversation");
  }

  // Determine run boundaries before filtering empty assistant messages.
  let start = 0;
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i];
    if (message?.role === "assistant" && message.stopReason !== "toolUse") { start = i + 1; break; }
  }
  const oldMessages = filterHistory(context.messages.slice(0, start));
  const currentMessages = filterHistory(context.messages);
  const oldSet = new Set(context.messages.slice(0, start));
  const results = currentMessages.filter((message): message is Extract<Message, { role: "toolResult" }> =>
    message.role === "toolResult" && !oldSet.has(message));
  const bodies = new Map<Message, string>();
  const total = results.reduce((sum, message) => sum + text(message).length, 0);
  let remaining = RESULT_BODY_BUDGET;
  const prioritized = [...results].reverse().sort((a, b) => Number(b.isError) - Number(a.isError));
  for (const [index, message] of prioritized.entries()) {
    const body = text(message);
    const reserved = Math.min(remaining, (prioritized.length - index - 1) * quote(OMITTED_BODY).length);
    const size = total <= RESULT_BODY_BUDGET ? body.length : Math.min(remaining - reserved, RESULT_BODY_CEILING, body.length);
    const rendered = limit(resultBody(message), size);
    bodies.set(message, rendered);
    remaining -= rendered.length;
  }

  // Filtering clones assistants, so use the filtered prefix length for chronological rendering.
  return [context.systemPrompt ? `# System prompt\n\n${quote(context.systemPrompt)}` : "",
    currentMessages.length > 1
      ? "# Conversation history\n\nThese messages restore prior conversation state. Do not repeat completed actions. Continue unfinished work, respecting later corrections and cancellations."
      : "",
    ...currentMessages.map((message, index) => render(message,
      message.role === "toolResult" && oldSet.has(message) ? quote("[Body omitted: completed run]") :
        bodies.get(message) ?? text(message, index < oldMessages.length)))].filter(Boolean).join("\n\n");
}
