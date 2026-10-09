// Compare conversation semantics, not metadata the Pi agent loop adds after streaming.
export const MESSAGE_FORMAT = "pi-semantic-v1";

export function serializeMessage(value: unknown): string {
  if (!isRecord(value)) throw new Error("Unsupported Pi message: expected an object");
  const { role, content } = value;
  const message: Record<string, unknown> = { role, content: projectContent(content) };

  switch (role) {
    case "system":
      // Section order affects the rendered instructions.
      message.sections = isRecord(value.sections) ? Object.entries(value.sections) : value.sections;
      message.toolsAdded = value.toolsAdded;
      message.toolsRemoved = value.toolsRemoved;
      break;
    case "user":
      break;
    case "assistant":
      message.stopReason = value.stopReason;
      message.errorMessage = value.errorMessage;
      message.deferred = value.deferred;
      break;
    case "toolResult":
      message.toolCallId = value.toolCallId;
      message.toolName = value.toolName;
      message.isError = value.isError;
      // PTY results use details to restore terminal handles.
      message.details = value.details;
      break;
    default:
      throw new Error(`Unsupported Pi message role: ${String(role)}`);
  }

  return JSON.stringify(message);
}

function projectContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error("Unsupported Pi message content: expected text or blocks");

  return content.map((block: unknown) => {
    if (!isRecord(block)) throw new Error("Unsupported Pi message content block");
    switch (block.type) {
      case "text":
        return { type: block.type, text: block.text };
      case "image":
        return { type: block.type, data: block.data, mimeType: block.mimeType };
      case "thinking":
        return { type: block.type, thinking: block.thinking, redacted: block.redacted };
      case "toolCall":
        return { type: block.type, id: block.id, name: block.name, arguments: block.arguments, namespace: block.namespace };
      default:
        throw new Error(`Unsupported Pi message content block: ${String(block.type)}`);
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
