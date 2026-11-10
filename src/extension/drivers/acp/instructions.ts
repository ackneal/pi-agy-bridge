import type { Tool } from "@earendil-works/pi-ai";
import type { BridgeMessage } from "../types.ts";
import {
  buildIntegrationInstructions,
  composeSystemPrompt as composeBasePrompt,
  composeBaseSystemPrompt as composeBasePromptWithoutTools,
  fingerprintSystemPrompt,
} from "../instructions.ts";

export const acpReferencedContent = `## Read referenced content
- Use Pi MCP tools for ordinary file operations, including original workspace files. Pi read, when available, supports text and images.
- Use the advertised ACP client reader, client_view_file, instead of Pi read for offload and metadata references. Limit client reads to current-session AGY offloads under brain/<current-session-id>/.system_generated/steps/ and allowed Pi MCP schema files under brain/<current-session-id>/mcp/pi-agy-bridge_pi/.
- These references are not ordinary workspace files. This interface does not authorize workspace, home-directory, or other conversations' files.
- When you need image content and have a current-session offload reference, use client_view_file if advertised. Do this before you claim that you cannot see or retrieve the image.
- Convert a local file:// artifact reference to an absolute filesystem path. For client_view_file, use absolute_path and start_line. The line offset is 1-based.
- Text pages contain raw source text. A start_line=N footer gives the next position when more remains. Follow it with the advertised reader as needed. Do not assume one page is complete.
- The isolated image observer provides derived descriptions and OCR, not direct vision.`;

export const integrationInstructions = buildIntegrationInstructions({
  referencedContent: acpReferencedContent,
});

export function composeSystemPrompt(messages: readonly BridgeMessage[], tools?: readonly Tool[]): string {
  return composeBasePrompt(integrationInstructions, messages, tools);
}

export function composeBaseSystemPrompt(messages: readonly BridgeMessage[]): string {
  return composeBasePromptWithoutTools(integrationInstructions, messages);
}

export { fingerprintSystemPrompt };
