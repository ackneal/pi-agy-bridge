# pi-agy-bridge

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

- **Pi Coding Agent**: Use a Node.js version supported by Pi. Development checks currently use `@earendil-works/pi-coding-agent` 1.0.2.
- **Antigravity CLI**: `agy` >= 1.1.15, installed at `~/.local/bin/agy` or available in your `PATH`.
- **Supported platforms**: macOS or Linux with Unix domain socket support. Native Windows is not supported.
- **CLI authentication**: Valid Antigravity CLI authentication is required to use models.

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

The bridge reuses your Antigravity CLI conversation across turns and can resume it after restarting Pi when the history still matches.

Switching Antigravity models does not by itself reset the conversation. If tools are still running, the current turn finishes with the previous model; the next request uses the selected model. Switching to another provider and back without a new assistant response also preserves the conversation.

When Pi history diverges—for example after compaction, branching, or a response from another provider—the bridge starts a new conversation using Pi's current instructions and history. It also rebuilds context if an existing conversation cannot be restored. Your Pi session remains unchanged.

### Model Discovery

The bridge reads Antigravity CLI's model catalog and caches it in Pi across restarts. If a refresh fails, it retains the cached catalog. Your Pi model overrides take precedence over the bridge's defaults.

### Token Usage

The bridge reports token usage from the latest model request, not the conversation's accumulated totals. The context count includes cache-read tokens so Pi can use it for context display and automatic compaction.

### Cancellation and Errors

Cancelling a request stops its Antigravity CLI process and closes the MCP connection. If the process does not initialize within 30 seconds, the bridge terminates it and reports an error to Pi.

Errors returned by Antigravity CLI, such as quota limits, do not by themselves reset the conversation when no tool calls are pending and Pi history still matches. You can select another Antigravity model and retry; the bridge attempts to resume the same conversation. The bridge does not automatically resend the failed request.

Input-stream failures, unexpected exits during an active request, invalid tool-result batches, MCP delivery failures, and blocked native tools invalidate the saved conversation reference. AGY terminal results or cancellation with pending tool calls also invalidate it. Checkpoints saved while tools are pending cannot be restored after a restart. The next request rebuilds context from Pi history.

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
