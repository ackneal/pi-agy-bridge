# pi-agy-bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Package Manager](https://img.shields.io/badge/managed_with-bun-black?logo=bun)](https://bun.sh)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)]()
[![Pi Extension](https://img.shields.io/badge/pi-extension-purple.svg)](https://github.com/earendil-works/pi-coding-agent)

A standalone Antigravity CLI (`agy`) provider and capability bridge plugin for [Pi](https://github.com/earendil-works/pi-coding-agent).

`pi-agy-bridge` lets Pi delegate reasoning and code generation to Antigravity CLI while keeping tool execution in Pi, aggregating token usage across AGY steps, discovering models dynamically, and synchronizing AGY sessions with Pi history.

---

## Features

- **Native Pi tool execution**: Pi tools (`read`, `edit`, `bash`, custom extensions, and PTY terminals) are exposed to AGY through an ephemeral local MCP server over Unix domain sockets. AGY delegates tool calls back to Pi's runtime environment and policy controls.
- **Aggregated token usage**: Input, output, cache-read, and thinking tokens are accumulated across AGY step updates and included in the final Pi assistant message. Final result usage is used as a fallback when AGY emits no step usage.
- **Dynamic model discovery**: Discovers available models directly via `agy models`, caches the catalog locally, and applies family-specific context windows (Claude, Gemini, GPT-OSS) alongside user `modelOverrides`.
- **Three-tier session synchronization**: Preserves long-running AGY sub-processes across sequential turns (continue), resumes existing conversations across restarts via conversation IDs (resume), or reconstructs branched history cleanly using structured XML payloads (rebuild).
- **Strict isolation & security**: Enforces a strict tool allowlist, restricts socket permissions to `0o600`, and virtualizes PTY terminal handles (`terminal-1`) to isolate internal process identifiers.

---

## Prerequisites

- **Pi Coding Agent**: `@earendil-works/pi-coding-agent` (>= 0.87.1)
- **Antigravity CLI**: `agy` (>= 1.1.15) installed and authenticated in your `$PATH`
- **Operating System**: macOS or Linux (requires Unix domain socket support)
- **Node.js**: Required by Pi and the packaged MCP executable; Node.js >= 22.6 is required to run this repository's TypeScript test command directly
- **Development Tooling**: [Bun](https://bun.sh) 1.3.x for dependency management and local workflows

---

## Installation

> **Note**: This plugin is not yet published to npm. Install it directly from Git using SSH (`git@`).

### Option 1: Install via Pi Package Manager (Recommended)

Install globally into your user settings (`~/.pi/agent/settings.json`):

```bash
pi install git:git@github.com:ackneal/pi-agy-bridge.git
```

Or install project-locally into `.pi/settings.json`:

```bash
pi install git:git@github.com:ackneal/pi-agy-bridge.git -l
```

### Option 2: Local Clone & Link (Development)

Clone the repository and install dependencies with Bun:

```bash
git clone git@github.com:ackneal/pi-agy-bridge.git
cd pi-agy-bridge
bun install

# Install the local directory into Pi
pi install ./
```

### Option 3: Direct CLI Flag

To test without adding the package to your settings, pass the entry point directly:

```bash
pi -e /path/to/pi-agy-bridge/src/index.ts
```

---

## Usage

### Selecting the AGY Provider

Once installed, the `agy` provider is registered automatically in Pi. You can select it interactively or specify an AGY model on the command line:

```bash
# Launch interactive Pi session with AGY
pi --model agy/gemini-3.8-flash

# Run a one-shot instruction
pi --model agy/gemini-3.8-flash "Analyze memory consumption in src/index.ts"
```

Inside an interactive Pi session:
- Type `/model` to browse discovered AGY models.
- Type `/provider agy` to switch active providers.

### Model Discovery & Overrides

Models are cached at `~/.pi/agent/cache/agy-models.json` and refreshed in the background via `agy models`. When a cache exists, `/model` can display it immediately without waiting for discovery. A model picker that is already open is not guaranteed to update in place; reopen `/model` to use the refreshed in-memory catalog. On first use without a cache, the initial catalog may be empty until background discovery finishes.

You can customize context windows or model behavior via `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "agy": {
      "modelOverrides": {
        "gemini-3.8-flash": {
          "name": "Gemini 3.8 Flash (AGY)",
          "contextWindow": 1048576,
          "maxTokens": 32768
        }
      }
    }
  }
}
```

Passing an explicit model list disables automatic discovery and uses that list directly:

```typescript
setupAgyProvider(pi, {
  models: [
    {
      id: "custom-model",
      name: "Custom AGY Model",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 272000,
      maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }
  ]
});
```

Pi `modelOverrides` still apply to explicitly configured models.

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

1. **Provider Hook**: When a turn begins, the bridge registers or verifies the `pi-bridge` AGY plugin under `~/.gemini/config/plugins/pi-agy-bridge`.
2. **Ephemeral MCP Server**: The bridge starts an IPC broker (`BridgeIPC`) bound to a dedicated Unix domain socket with `0o600` file permissions. Active Pi tools and their schemas are converted into MCP tool definitions.
3. **Sub-process Launch**: The runtime spawns `agy --agent pi-bridge --input-format stream-json --output-format stream-json`, injecting the socket endpoint via environment variables.
4. **Bi-directional Tool Relaying**: AGY requests tool executions via `call_mcp_tool`. The MCP broker validates the tool against an allowlist, executes it within Pi, and returns the output to AGY.
5. **Stream Translation**: AGY's line-delimited JSON stream is parsed into native Pi assistant events such as `text_delta`, `toolcall_start`, and `done`. Aggregated usage is attached to the final assistant message.

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
