// Core cases target Bridge adaptations that can change when ACP is upgraded.
export const scenarios = [
  ["AUTH-probe", "Authenticated noninteractive probe", "session/new confirms authentication without allowing browser interaction", "core"],
  ["AUTH-noauth", "Unauthenticated noninteractive probe", "An independently unauthenticated environment returns false without browser interaction", "core"],
  ["AUTH-login", "Explicit Pi /login", "Advertised method selection, authenticate and session/new confirmation use existing authentication paths", "core"],
  ["AUTH-login-cancel", "Cancel explicit login", "Cancellation reaches method selection, avoids authenticate and cleans up", "core"],
  ["CONFIG-instructions", "Instructions and session configuration", "systemPrompt.append reaches AGY; model and optional thinking settings are applied and verified", "core"],
  ["B-native", "Native tool boundary", "Disabled native configuration, denied non-MCP permission, Pi handler execution and unchanged canary", "core"],
  ["A-success", "MCP successful result", "Real Pi handler arguments and ID persist; unique result returns to AGY and native prompt is accounted exactly once", "core"],
  ["A-error", "MCP error result", "Real Pi error result returns to AGY and turn completes with exactly one native-prompt accounting entry", "core"],
  ["USAGE-turn", "Real Pi tool-free accounting", "Final ACP response usage persists exactly once, separately from context occupancy", "core"],
  ["A-update-success", "Steer a successful pending Pi tool", "Real Pi steering travels with the MCP result; AGY applies the update without a second native prompt", "core"],
  ["A-update-error", "Steer a failed pending Pi tool", "Real Pi steering travels with the MCP error; AGY applies the update without retrying", "core"],
  ["D-history", "Real Pi imported history semantics", "Fresh provider reconstruction preserves success/error/aborted/unknown status, omits result bodies and does not replay operations", "core"],
  ["READ-scope", "Client Read scope protection (seeded fixtures)", "Actual read RPCs allow current-session artifacts and reject outside, cross-session, symlink and invalid paths", "core"],
  ["IMG-prompt-small", "Direct small image prompt", "Actual prompt image reaches ACP and AGY reads the fixture-only visual marker", "core"],
  ["IMG-prompt-large", "Direct large image prompt", "Large valid image reaches ACP with the correct content and readable visual marker", "core"],
  ["IMG-mcp-small", "Small MCP image result", "Real Pi image result reaches AGY, with actual inline/offload route recorded", "core"],
  ["IMG-mcp-offload", "Real MCP image offload recovery", "AGY-created image offload is recovered through Client Read and an isolated image observer without replay", "core"],
  ["OFFLOAD-text", "Real MCP text offload and paging", "AGY-created text offload is read in ordered pages to recover a hidden tail marker without tool replay", "core"],
  ["G-compaction", "Actual Pi post-compaction continuity", "Actual Pi compaction followed by fresh runtime reconstruction and real tool continuity", "core"],
  ["F-pending", "Cancel pending MCP call", "Cancel reaches pending Pi call, releases ownership and allows a new runtime", "core"],
  ["C-lifecycle", "Session creation/continuation smoke", "A new session handles two turns with a retained context marker and unchanged session ID", "core"],
  ["D-rebuild", "Extended Pi context reconstruction", "Unavailable and incompatible saved state rebuilds ordered Pi history without completed tool replay", "extended"],
  ["F-before", "Extended cancel before submission", "Ownership gate prevents prompt submission; next request works", "extended"],
  ["F-active", "Extended cancel active turn", "Cancel reaches an active native prompt, disposes it and allows a new runtime", "extended"],
] as const;

export type ScenarioId = typeof scenarios[number][0];
