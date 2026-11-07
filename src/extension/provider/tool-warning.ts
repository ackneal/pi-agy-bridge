import { stripVTControlCharacters } from "node:util";
import type { DriverId, ToolWarningReason, ToolWarningStatus } from "../drivers/types.ts";

const MAX_NAME_LENGTH = 120;

export function formatToolWarning(driver: DriverId, name: string, _args: unknown, status: ToolWarningStatus, reason?: ToolWarningReason): string {
  if (reason === "notification-limit") {
    return `Antigravity ${driver.toUpperCase()}: Tool activity tracking limit reached; additional tool calls cannot be verified.`;
  }

  const sanitized = stripVTControlCharacters(name)
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "").trim();
  const tool = sanitized.length > MAX_NAME_LENGTH ? `${sanitized.slice(0, MAX_NAME_LENGTH - 1)}…` : sanitized || "unknown tool";

  return `Antigravity ${driver.toUpperCase()}: Unverified tool activity — ${tool} (status: ${status}).`;
}
