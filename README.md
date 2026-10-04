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
- **Dynamic model discovery**: Discovers available models directly via `agy models`, persists the catalog through Pi’s native models-store, and applies family-specific context windows (Claude, Gemini, GPT-OSS) alongside user `modelOverrides`.
- **Three-tier session synchronization**: Preserves long-running AGY sub-processes across sequential turns (continue), resumes existing conversations across restarts via conversation IDs (resume), or reconstructs branched history cleanly using structured XML payloads (rebuild).
- **Strict isolation & security**: Enforces a strict tool allowlist, restricts socket permissions to `0o600`, and virtualizes PTY terminal handles (`terminal-1`) to isolate internal process identifiers.

---

## Prerequisites

- **Pi Coding Agent**: `@earendil-works/pi-coding-agent` (>= 1.0.0, < 2.0.0)
- **Antigravity CLI**: `agy` (>= 1.1.15) installed in your `$PATH`; model use requires a valid AGY login
- **Operating System**: macOS or Linux (requires Unix domain socket support)
- **Node.js**: Required by Pi and the packaged MCP executable; Node.js >= 22.6 is required to run this repository's TypeScript test command directly

---

## Quick Start

Install the bridge directly from Git:

```bash
pi install git:git@github.com:ackneal/pi-agy-bridge.git
```

Start Pi. If `auth.json` has no `agy` credential, the bridge checks existing AGY login in the background using the CLI's built-in `agy --print /usage` report, not a model request. This can take several seconds; each probe allows up to 30 seconds without blocking Pi. The check succeeds only when the CLI exits normally and its output contains `Quota` or `Limit Remaining`. Unrecognized output leaves authentication status unknown; the bridge does not retry. The automatic check never asks for an authorization code. A successful quota report saves a local no-secret OAuth setup marker and refreshes the model selector. Missing CLI, no login, or a timeout leaves credentials unchanged and does not block Pi. This first background enablement happens after initial model selection and does not automatically switch models.

To sign in explicitly, run Pi’s native `/login` and select **Antigravity CLI [pi-agy-bridge]**. The same quota report checks existing AGY login first, so a cached-login check can also take several seconds. If AGY explicitly reports that authentication is required, the bridge displays AGY's browser URL and forwards the authorization code entered in Pi back to AGY. No model prompt is sent.

Interactive login uses the system `script`, `cat`, and `ps` utilities and requires PTY access; its real AGY handshake still needs validation. If PTY access is unavailable, authenticate with `agy` in a terminal and retry.

Pi treats this flow as a subscription login, not an API key (`isSubscription: true`); this classification does not verify subscription entitlements. Pi stores only a local `type: "oauth"` no-secret setup marker with empty `access` and `refresh` values and a one-year expiry, while actual credentials remain owned and saved by AGY CLI. Existing markers are used without another authentication probe. Legacy enabled `api_key` markers are upgraded to OAuth at startup without probing. OAuth refresh only extends the local expiry by one year: it makes no network request and does not change the login epoch. If the AGY login expires, the AGY runtime reports the failure; use `/login` to authenticate again.

Open `/model`, search for `agy`, and select a model labeled `[agy]`. Available AGY models are detected automatically from `agy models`.

Pi’s `/logout` for AGY deletes the Pi credential, hides available AGY models, and blocks future bridge requests. It keeps the AGY CLI login; use `/login` and select **Antigravity CLI [pi-agy-bridge]** again to check that login or sign in again. On the next Pi restart, an AGY CLI login that is still valid enables the bridge automatically again. Reloading or branching a session does not automatically re-enable it in the same Pi process.

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

### Model Discovery and Persistence

Models discovered through `agy models` are persisted and restored through Pi’s native models-store. Model metadata defaults are defined in `discovery/model.json`; `models.json.modelOverrides` takes precedence.

### Tool Execution

The bridge exposes active Pi tools to AGY through an ephemeral MCP server over a private Unix domain socket. AGY delegates tool calls back to Pi, where they run with Pi's permissions, session resources, and policy controls. AGY cannot bypass Pi by invoking unapproved executable tools directly.

The bridge follows Pi's current tool declarations, including transcript tool additions and removals. It does not expose every registered tool. Declared codemode and tool-search entrypoints are relayed like other Pi tool calls; the underlying tools remain managed by Pi.

### Session and Conversation Synchronization

Sequential turns reuse the same AGY process and conversation. After Pi or the AGY process restarts, the bridge resumes the AGY conversation when its recorded history still matches the active Pi branch.

Pi compaction, branching, or another history rewrite invalidates that continuation. The bridge closes the old AGY runtime, starts a new AGY conversation, and reconstructs its context from Pi's current system instructions, compaction summary, retained messages, and current message. The Pi session itself remains unchanged.

### Usage Accounting

AGY's `step_update` events carry per-request usage; each assistant message reports the latest step's snapshot. `totalTokens` is computed as `input + output + cacheRead` (AGY's own `total_tokens` field omits cache reads, which would make the reported context size swing with the cache hit/miss cycle). The session-cumulative `result` usage is billing data only and is never merged into Pi-facing usage, so Pi's threshold and overflow compaction checks always see the true single-request context size.

---

## Programmatic API

For custom Pi harnesses or scripting, use a runtime or loader that supports TypeScript dependencies (such as Bun). The package exports TypeScript source, not compiled JavaScript:

```typescript
import { setupAgyProvider } from "pi-agy-bridge";

setupAgyProvider(pi, {
  agyPath: "agy",            // Custom binary path (defaults to "agy")
  minVersion: "1.1.15",      // Minimum supported CLI version
  agentName: "pi-bridge",    // Bridge agent configuration name
  pluginDir: "./plugin",     // Optional custom AGY plugin source directory
  authPath: "./auth.json",   // Optional SDK custom credential storage path
  debug: false               // Enable verbose stderr logging
});
```

`authPath?: string` defaults to `auth.json` under Pi’s `getAgentDir()`. SDK harnesses with a custom auth path should pass the same path here so startup detection reads and writes the correct credential store.

### Health Check

Run `/agy-bridge:doctor` to check the AGY executable and version, installed plugin version, configured model count (when supplied) or cached catalog count from Pi’s models-store, and MCP entrypoint. The report is in English and does not read the models-store directly, install or update plugins, or run model discovery. Missing or outdated plugins are handled automatically on the next AGY runtime start.

The report shows the most recent explicit-login or startup auto-detection snapshot (unknown means no login was verified in the current Pi process) and recent login, plugin installation/update, and model discovery errors for the current Pi process only. An existing setup marker alone does not establish that authentication is valid. Doctor does not probe live authentication; model execution and Unix socket creation are also not tested.

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
- **Startup credential race**: Pi 1.0.0 does not expose a conditional credential commit. A login or logout that occurs between the background check's final credential comparison and Pi's write can still be overwritten.
- **Sandboxed Environments**: Environments that strictly restrict Unix socket creation (`EPERM`) cannot run the MCP broker.
- **External Tools**: Non-Pi AGY internal tools (except internal coordination tools like `call_mcp_tool`) are blocked by design to prevent bypassing Pi policy.

---

## License

[MIT](LICENSE)
