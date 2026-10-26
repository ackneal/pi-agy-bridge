# pi-agy-bridge

[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)]()
[![Pi Extension](https://img.shields.io/badge/pi-extension-purple.svg)](https://github.com/earendil-works/pi-coding-agent)

Use Antigravity ACP (default) or explicitly selected Antigravity CLI (`agy`) as the model runtime for [Pi](https://github.com/earendil-works/pi-coding-agent), while Pi manages tools, permissions, and conversation history.

The bridge invokes the selected installed backend and uses its authentication flow. It does not extract authentication tokens or call Antigravity's backend APIs directly.

## Features

- **Native Pi tools**: Run filesystem tools, shell commands, custom extensions, and PTY terminals in Pi through a local MCP bridge.
- **Native model selection**: Select Antigravity models in Pi's model picker, with automatic discovery and catalog caching.
- **Conversation continuity**: Reuse conversations across turns and restarts, rebuilding context when Pi history changes.
- **Context usage reporting**: Provide per-request token usage for Pi's context display and automatic compaction.

## Requirements

- **Pi Coding Agent**: Use a Node.js version supported by Pi. Development checks currently use `@earendil-works/pi-coding-agent` 1.0.2.
- **Default ACP backend**: Install the Antigravity ACP server; configure `acpPath` or `AGY_ACP_BIN` if needed. The bridge also checks `~/.local/opt/agy-acp` and `~/.local/bin/agy_acp_server`.
- **Optional CLI backend**: Explicitly select CLI, installed at `~/.local/bin/agy` or available in your `PATH`. Last tested with `agy` 1.3.3.
- **Supported platforms**: macOS or Linux with Unix domain socket support. Native Windows is not supported.
- **Backend authentication**: Valid authentication for the selected backend is required to make model requests.

## Quick Start

### 1. Install

Install the Pi package from npm:

```bash
pi install npm:@ackneal/pi-agy-bridge
```

Alternatively, install directly from GitHub:

```bash
pi install git:github.com/ackneal/pi-agy-bridge
```

Start Pi after installation. ACP is selected by default. Only explicitly selected CLI installs or updates the bundled CLI plugin.

### 2. Sign In (If Needed)

If the bridge is not yet configured in Pi, it checks for existing selected-backend authentication in the background at startup. If you are already authenticated, allow a few seconds for your models to appear, then continue to model selection.

To sign in through Pi, run `/login`, select the selected Antigravity backend labeled **[pi-agy-bridge]**, and follow the authorization prompts.

Your credentials remain with the selected backend. Pi stores only a local setting that enables the bridge.

> **Note:** `/logout` disables the bridge in Pi but does not sign you out of the selected backend. Restarting Pi may automatically enable the bridge again.

### 3. Choose a Model

Open `/model`, search for `agy`, and select a model labeled `[agy]`. Continue using Pi's tools and commands as usual.

## Driver Selection and CLI Migration

ACP is the fixed default. Executable availability and existing paths do not select a backend. ACP failures never fall back to CLI.

To keep using CLI after upgrading, explicitly switch in Pi:

```text
/agy-bridge:driver cli
/agy-bridge:driver acp
```

Run `/agy-bridge:driver` without arguments for status. A switch applies to the current bridge instance only and is not automatically saved across restart.

Each driver locates its own executable and handles startup. Set `AGY_ACP_BIN` to override ACP executable discovery. Native sessions use Pi's workspace directory; this working directory is not a filesystem authorization boundary.

## How It Works

One `agy` provider shares model caching, tools, Pi output, and session ownership across both backends. CLI uses Stream JSON; ACP uses its session protocol. Saved session versions prevent incompatible restores across backends. Unsupported older saved formats rebuild from Pi history on the next request; the Pi conversation is preserved.

### Tools and Permissions

The bridge exposes Pi's current tools through a local MCP server. Requests travel from the selected backend through the server and a Unix socket to Pi, where tools run under Pi's policies. Results return along the same path.

Pi also manages custom tools and skills. Pi tool calls execute through the MCP bridge.

The ACP driver requests `enabledTools: []`, denies non-MCP permission requests, and exposes no client write or terminal capability. These are configuration and protocol checks, not a sandbox around AGY. Backend enforcement of native-tool filtering and system-instruction delivery still needs real-backend validation.

### Sessions and Context

The bridge reuses your selected-backend conversation across turns and can resume it after restarting Pi when the history still matches.

Switching Antigravity models preserves the conversation. If tools are still running, the model change applies to the next request.

After compaction, branching, a response from another provider, or a failed restore, the bridge starts a new conversation from Pi's current instructions and history. Your Pi session remains unchanged.

ACP resolves Pi's current system instructions, including section updates and removals, and sends them with ACP-specific integration instructions through Antigravity's system-prompt append extension. The server must advertise support for this extension. Instruction changes rebuild the ACP conversation, including during a tool handoff; completed Pi tool results remain history and are not executed again. Saved ACP references without matching instruction metadata also rebuild. CLI instruction handling is unchanged.

### Model Discovery

The bridge reads the selected backend's model catalog and caches it in Pi across restarts. If a refresh fails, it retains the cached catalog. Your Pi model overrides take precedence over the bridge's defaults.

### Token Usage

The bridge reports token usage from the latest model request, not the conversation's accumulated totals. The context count includes cache-read tokens so Pi can use it for context display and automatic compaction.

### Cancellation and Errors

Cancelling a request stops the selected runtime and closes the MCP connection. For CLI, if the process does not initialize within 30 seconds, the bridge terminates it and reports an error to Pi.

After a quota error, you can select another Antigravity model and retry. The bridge reuses the conversation when it is safe to do so; it does not automatically resend failed requests.

If a runtime or tool failure makes the conversation unsafe to reuse, the next request rebuilds context from Pi history.

## Troubleshooting

Run `/agy-bridge:doctor` in Pi for selected-backend diagnostics. CLI reports plugin status and queries quota on demand; a successful query confirms authentication. Backend capabilities differ; missing quota is not fabricated.

- **ACP unavailable**: Check `acpPath`, `AGY_ACP_BIN`, and executable permissions. Missing/non-executable ACP or startup, authentication, and network failures never choose CLI. Fix ACP or explicitly run `/agy-bridge:driver cli`.
- **Unauthenticated models**: Default ACP model entries or cached models may appear before login; their presence does not confirm authentication, connectivity, or request success. Run `/login` for the selected backend.
- **Missing models**: Retry `/login` and `/model`, then inspect doctor output. For explicitly selected CLI, `agy models` checks availability directly.
- **Sign-in failures**: Retry `/login`; if ACP requires unsupported terminal authentication, authenticate externally and retry. For CLI, sign in using `agy` in a terminal.
- **Offload limitations**: ACP restricted artifact reads, text pagination, and image observer recovery are pending PR2. Do not assume full image/offload support or real-server full validation.

### Diagnostic Logs

For additional detail, enable logging before starting Pi:

```bash
export AGY_BRIDGE_DEBUG=1
```

Start Pi from the same terminal. Diagnostic logs are written to `stderr` with `[Antigravity CLI:...]` tags.

## Development

Use Bun for dependency installation and development commands:

```bash
bun install
bun run check:version
bun run typecheck
bun run test
```

The pinned Pi packages in `devDependencies` are for local checks only; Pi provides them when loading an installed package.

These commands preserve the existing package scripts: typechecking uses TypeScript, and the test suite uses Node.js with `node:test` and type stripping, not Bun's test runner. A Node.js version supporting the test script's flags is required.
