# pi-agy-bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)]()
[![Pi Extension](https://img.shields.io/badge/pi-extension-purple.svg)](https://github.com/earendil-works/pi-coding-agent)

Use Antigravity CLI (`agy`) as the model runtime for [Pi](https://github.com/earendil-works/pi-coding-agent), while Pi manages tools, permissions, and conversation history.

The bridge invokes your installed Antigravity CLI directly and uses its authentication flow. It does not extract authentication tokens or call Antigravity's backend APIs directly.

## Features

- **Native Pi tools**: Run filesystem tools, shell commands, custom extensions, and PTY terminals in Pi through a local MCP bridge.
- **Native model selection**: Select Antigravity CLI models in Pi's model picker, with automatic discovery and catalog caching.
- **Conversation continuity**: Reuse conversations across turns and restarts, rebuilding context when Pi history changes.
- **Context usage reporting**: Provide per-request token usage for Pi's context display and automatic compaction.

## Requirements

- **Pi Coding Agent**: `@earendil-works/pi-coding-agent` >= 1.0.0, < 2.0.0, using a Node.js version supported by Pi.
- **Antigravity CLI**: `agy` >= 1.1.15, installed at `~/.local/bin/agy` or available in your `PATH`.
- **Supported platforms**: macOS or Linux with Unix domain socket support. Native Windows is not supported.
- **CLI authentication**: Valid Antigravity CLI authentication is required to use models.

## Quick Start

### 1. Install

```bash
pi install git:github.com/ackneal/pi-agy-bridge
```

Start Pi after installation. The bridge installs or updates its bundled plugin automatically when you use an Antigravity CLI model.

### 2. Sign In (If Needed)

If the bridge is not yet configured in Pi, it checks for existing Antigravity CLI authentication in the background at startup. If you are already authenticated, allow a few seconds for your models to appear, then continue to model selection.

To sign in to Antigravity CLI through Pi, run `/login`, select **Antigravity CLI [pi-agy-bridge]**, and follow the authorization prompts.

Your credentials remain with Antigravity CLI. Pi stores only a local setting that enables the bridge.

> **Note:** `/logout` disables the bridge in Pi but does not sign you out of Antigravity CLI. Restarting Pi may automatically enable the bridge again.

### 3. Choose a Model

Open `/model`, search for `agy`, and select a model labeled `[agy]`. Continue using Pi's tools and commands as usual.

## How It Works

Pi sends context to Antigravity CLI through standard input and receives streamed responses and token usage through standard output.

### Tools and Permissions

The bridge exposes Pi's current tools through a local MCP server. Requests travel from Antigravity CLI through the server and a Unix socket to Pi, where tools run under Pi's policies. Results return along the same path.

Pi also manages custom tools and skills. Antigravity CLI's own executable tools are blocked, keeping tool execution in Pi.

### Sessions and Context

Sequential turns reuse the same Antigravity CLI conversation. The bridge saves a conversation reference with the Pi session to resume it after a restart when the history still matches.

After compaction, branching, or other history changes, the bridge rebuilds the context in a new conversation using Pi's current instructions, retained messages, and tool results. The Pi session itself is unchanged.

> **Note:** The bridge reuses existing Antigravity CLI conversations whenever possible instead of creating a one-shot conversation for each request, avoiding unnecessary conversation buildup.

### Model Discovery

The bridge reads Antigravity CLI's model catalog and caches it in Pi across restarts. If a refresh fails, it retains the cached catalog. Your Pi model overrides take precedence over the bridge's defaults.

### Token Usage

The bridge reports token usage from the latest model request, not the conversation's accumulated totals. The context count includes cache-read tokens so Pi can use it for context display and automatic compaction.

### Cancellation and Errors

Cancelling a request stops its Antigravity CLI process and closes the MCP connection. If the process does not initialize within 30 seconds, the bridge terminates it and reports an error to Pi.

Input-stream failures and unexpected exits during an active request are also reported as errors, rather than leaving Pi waiting for a response.

## Troubleshooting

Run `/agy-bridge:doctor` in Pi to check the Antigravity CLI version, plugin status, and recent errors. The report shows the last known authentication status; use `/login` for a fresh check.

- **Missing models**: Run `/login`, select **Antigravity CLI [pi-agy-bridge]**, then reopen `/model`. If models are still missing, run `agy models` in a terminal to check model availability directly.
- **Sign-in failures**: If authentication expires, run `/login` again. If interactive sign-in fails in Pi, sign in to Antigravity CLI in a terminal using `agy`, then retry `/login` in Pi.

### Diagnostic Logs

For additional detail, enable logging before starting Pi:

```bash
export AGY_BRIDGE_DEBUG=1
```

Start Pi from the same terminal. Diagnostic logs are written to `stderr` with `[agy:...]` tags.

## License

[MIT](LICENSE)
