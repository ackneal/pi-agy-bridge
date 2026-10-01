# pi-agy-bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Package Manager](https://img.shields.io/badge/managed_with-bun-black?logo=bun)](https://bun.sh)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)]()
[![Pi Extension](https://img.shields.io/badge/pi-extension-purple.svg)](https://github.com/earendil-works/pi-coding-agent)

A standalone Antigravity CLI (`agy`) provider and capability bridge plugin for [Pi](https://github.com/earendil-works/pi-coding-agent).

`pi-agy-bridge` lets Pi delegate reasoning and code generation to Antigravity CLI while everything else stays native to Pi: tools execute in Pi's runtime under its policy controls, per-request token usage feeds Pi's context display and auto-compaction, models are discovered dynamically into the native model picker, and AGY sessions stay synchronized with Pi history.

---

## Features

- **Native Pi tool execution**: Pi tools (`read`, `edit`, `bash`, custom extensions, and PTY terminals) are exposed to AGY through an ephemeral local MCP server over Unix domain sockets. AGY delegates tool calls back to Pi's runtime environment and policy controls.
- **Per-request token usage**: Input, output, cache-read, and thinking tokens are reported per model request (the latest AGY step's snapshot). AGY's session-cumulative `result` usage is intentionally excluded so Pi's context display and auto-compaction decisions operate on real context size.
- **Dynamic model discovery**: Discovers available models directly via `agy models`, caches the catalog locally, and applies family-specific context windows (Claude, Gemini, GPT-OSS) alongside user `modelOverrides`.
- **Three-tier session synchronization**: Preserves long-running AGY sub-processes across sequential turns (continue), resumes existing conversations across restarts via conversation IDs (resume), or reconstructs branched history cleanly using structured XML payloads (rebuild).
- **Strict isolation & security**: Enforces a strict tool allowlist, restricts socket permissions to `0o600`, and virtualizes PTY terminal handles (`terminal-1`) to isolate internal process identifiers.

---

## Prerequisites

- **Pi Coding Agent**: `@earendil-works/pi-coding-agent` (>= 0.87.1)
- **Antigravity CLI**: `agy` (>= 1.1.15) installed and authenticated in your `$PATH`
- **Operating System**: macOS or Linux (requires Unix domain socket support)
- **Node.js**: Required by Pi and the packaged MCP executable; Node.js >= 22.6 is required to run this repository's TypeScript test command directly

---

## Quick Start

Install the bridge directly from Git:

```bash
pi install git:git@github.com:ackneal/pi-agy-bridge.git
```

Open `/model`, search for `agy`, and select a model labeled `[agy]`.

Available AGY models are detected automatically from `agy models`.

---

## How It Works

```text
┌────────────────────────┐      Unix Domain Socket       ┌────────────────────────┐
│   Pi Coding Harness    │◄─────────────────────────────►│    Antigravity CLI     │
│  (@earendil-works/pi)  │          MCP Broker           │     (`agy` runtime)    │
└───────────┬────────────┘                               └───────────┬────────────┘
            │                                                        │
    Native Pi Tools                                            call_mcp_tool
 (read, edit, bash, pty)                                   (exposes Pi tools via MCP)
```

### Tool Execution

The bridge exposes active Pi tools to AGY through an ephemeral MCP server over a private Unix domain socket. AGY delegates tool calls back to Pi, where they run with Pi's permissions, session resources, and policy controls. AGY cannot bypass Pi by invoking unapproved executable tools directly.

### Session and Conversation Synchronization

Sequential turns reuse the same AGY process and conversation. After Pi or the AGY process restarts, the bridge resumes the AGY conversation when its recorded history still matches the active Pi branch.

Pi compaction, branching, or another history rewrite invalidates that continuation. The bridge closes the old AGY runtime, starts a new AGY conversation, and reconstructs its context from Pi's current system instructions, compaction summary, retained messages, and current message. The Pi session itself remains unchanged.

### Usage Accounting

AGY's `step_update` events carry per-request usage; each assistant message reports the latest step's snapshot. `totalTokens` is computed as `input + output + cacheRead` (AGY's own `total_tokens` field omits cache reads, which would make the reported context size swing with the cache hit/miss cycle). The session-cumulative `result` usage is billing data only and is never merged into Pi-facing usage, so Pi's threshold and overflow compaction checks always see the true single-request context size.

---

## Programmatic API

For custom Pi harnesses or scripting:

```typescript
import { setupAgyProvider } from "pi-agy-bridge";

setupAgyProvider(pi, {
  agyPath: "agy",            // Custom binary path (defaults to "agy")
  minVersion: "1.1.15",      // Minimum supported CLI version
  agentName: "pi-bridge",    // Bridge agent configuration name
  pluginDir: "./plugin",     // Optional custom AGY plugin source directory
  debug: false               // Enable verbose stderr logging
});
```

### Health Check

Run `/agy-bridge:doctor` to check the AGY executable and version, installed
plugin version, model cache, and MCP entrypoint. The report is in English and
does not install or update plugins or run model discovery. Missing or outdated
plugins are handled automatically on the next AGY runtime start.

Recent plugin installation/update and model discovery errors are shown for the
current Pi process only; restarting Pi clears these records. Authentication,
model execution, and Unix socket creation are not tested.

### Debugging

Enable verbose diagnostic logs across all bridge components:

```bash
export AGY_BRIDGE_DEBUG=1
```

Logs are printed to `stderr` with scoped tags such as `[agy:mcp]`, `[agy:process]`, `[agy:session]`, and `[agy:events]`.

---

## Development

The project is developed and managed using [Bun](https://bun.sh).

```bash
# Install dependencies
bun install

# Run TypeScript type check
bun run typecheck

# Run test suite
bun run test
```

---

## Limitations

- **Platform**: Requires Unix domain sockets. Supported on macOS and Linux. Native Windows is unsupported; WSL2 may work but is not covered by the test suite.
- **Sandboxed Environments**: Environments that strictly restrict Unix socket creation (`EPERM`) cannot run the MCP broker.
- **External Tools**: Non-Pi AGY internal tools (except internal coordination tools like `call_mcp_tool`) are blocked by design to prevent bypassing Pi policy.

---

## License

[MIT](LICENSE)
