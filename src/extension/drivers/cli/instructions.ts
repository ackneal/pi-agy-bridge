import type { Tool } from "@earendil-works/pi-ai";
import type { BridgeMessage } from "../types.ts";
import {
  buildIntegrationInstructions,
  composeSystemPrompt as composeBasePrompt,
  composeBaseSystemPrompt as composeBasePromptWithoutTools,
  fingerprintSystemPrompt,
} from "../instructions.ts";

export const cliReferencedContent = `## Read referenced content
- Use Pi MCP tools for ordinary file operations. Pi MCP \`read\` can read text and images.
- Large tool outputs may be stored in temporary files. Use native \`read_file\` directly to read needed content supplied as a file reference.
- Use native \`read_file\` only for artifacts under the current conversation's \`.system_generated/steps/\` and allowed Pi MCP schema files under \`mcp/pi-agy-bridge_pi/\`, not ordinary workspace files.
- Set \`Path\` to the referenced local path. Convert \`file://\` URIs to local paths if needed.`;

export const integrationInstructions = buildIntegrationInstructions({
  referencedContent: cliReferencedContent,
});

export function composeSystemPrompt(messages: readonly BridgeMessage[], tools?: readonly Tool[]): string {
  return composeBasePrompt(integrationInstructions, messages, tools);
}

export function composeBaseSystemPrompt(messages: readonly BridgeMessage[]): string {
  return composeBasePromptWithoutTools(integrationInstructions, messages);
}

export { fingerprintSystemPrompt };
