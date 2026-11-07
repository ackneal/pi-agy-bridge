# pi-agy-bridge

[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)]()
[![Pi Extension](https://img.shields.io/badge/pi-extension-purple.svg)](https://github.com/earendil-works/pi-coding-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Use Antigravity models in Pi without changing how Pi works.**

The bridge connects Antigravity models to [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent). Pi manages the conversation and executes registered tools.

The bridge supports two drivers:

- **Antigravity ACP (`acp`):** Connects to the standalone Antigravity ACP server managed by the bridge.
- **Antigravity CLI (`cli`):** Connects to the user-installed Antigravity CLI through `agy acp --stdio`.

Both drivers communicate over the Agent Client Protocol (ACP). Each driver uses its own runtime, model catalog, and capabilities while Pi retains control of tools, extensions, skills, and session history.

---

## Architecture

**Pi runs the agent. Antigravity provides the models.**

```text
Pi Coding Agent
  |  Prompts and session context
  v
pi-agy-bridge
  |  ACP protocol
  +-- acp: Antigravity ACP (managed ACP server)
  |
  +-- cli: Antigravity CLI (installed `agy` CLI)
  |
  v
Antigravity models
  |
  |  Tool requests
  v
Local MCP bridge
  |
  v
Pi tools -> Results return to the model
```

Both drivers communicate over the ACP protocol. The selected driver determines whether the bridge connects to the managed Antigravity ACP server or the installed Antigravity CLI, selecting the corresponding runtime, model catalog, and capabilities.

---

## Features

- **Native Pi Experience** — Keep Pi tools, extensions, skills, and session history.
- **Pi Tool Integration** — Run registered tool requests through Pi with its applicable permissions.
- **Two Drivers, One Protocol** — Choose Antigravity ACP or Antigravity CLI. Both drivers communicate over the ACP protocol.
- **Session Continuity** — Reuse compatible sessions. Restore context from Pi history when needed.
- **Image Support** — Read images through Pi tools. The ACP driver also supports automatic image loading and uses an observer for offloaded images.
- **Automatic ACP Setup** — Download and verify the pinned ACP server.
- **Diagnostics** — Check your setup with `/agy-bridge:doctor`. The CLI driver also reports account quotas.

---

## Requirements

| Requirement | Details |
| :--- | :--- |
| **Operating System** | macOS or Linux. Native Windows is not supported. |
| **Pi Coding Agent** | `@earendil-works/pi-coding-agent`. |
| **Antigravity ACP Driver (Default)** | The bridge installs the ACP server automatically. |
| **Antigravity CLI Driver (Optional)** | Install `agy` at `~/.local/bin/agy` or add it to your `PATH`. Tested with `agy 1.5.2`. |

---

## Quick Start

### 1. Install the Extension

Install the extension with Pi:

```bash
pi install npm:@ackneal/pi-agy-bridge
```

Or install it from GitHub:

```bash
pi install git:github.com/ackneal/pi-agy-bridge
```

### 2. Sign In

1. Run:
   ```text
   /login
   ```
2. Select **Antigravity [pi-agy-bridge]** from the provider list.
3. Complete sign-in in your browser.

> Startup checks and diagnostics do not open a sign-in browser. Use `/login` to sign in.

### 3. Select a Model

1. Open the model selector:
   ```text
   /model
   ```
2. Type `agy` to find Antigravity models. Available models depend on the selected driver.
3. Select a model and start using Pi.

---

## Command Reference

| Command | Description |
| :--- | :--- |
| `/login` | Sign in to Antigravity through Pi. |
| `/model` | Select an available Antigravity model. |
| `/agy-bridge:driver` | Choose the ACP or CLI driver. |
| `/agy-bridge:doctor` | Check driver setup, authentication, and model discovery. |

Driver and doctor results are user-only notifications, not model conversation messages. Without a UI, results are written to `stderr`.

---

## How It Works

### Tool Execution

Antigravity models request tools through the bridge. Pi runs registered tool requests and returns the results. The bridge limits native tool capabilities through the selected driver.

### Choose a Driver

Both drivers communicate over the **ACP protocol** and route supported tool requests back through Pi. The difference is the backend process and the capabilities each driver exposes.

| | Antigravity ACP (`acp`, default) | Antigravity CLI (`cli`, optional) |
| :--- | :--- | :--- |
| Backend process | Managed Antigravity ACP server | User-installed `agy` CLI (`agy acp --stdio`) |
| Protocol | ACP | ACP |
| Setup | Installed and managed automatically | Install and maintain `agy` yourself |
| Models | Managed ACP model catalog | `agy` model catalog, including supported third-party models |
| Pi tools | Through the Pi MCP bridge | Through the Pi MCP bridge |
| Image reads | Pi tool reads, including observer-assisted offloaded images | Pi tool reads, including current-session artifacts |
| Automatic image loading | Supported for images referenced in user messages | Not provided by this driver |
| Usage information | Model token usage | Model token usage and CLI quota information |

**Choose Antigravity ACP (`acp`)** for automatic setup and automatic image loading. **Choose Antigravity CLI (`cli`)** if you use the installed `agy` CLI or need its third-party model catalog.

Use `/agy-bridge:driver` to switch drivers and `/model` to see available models. On startup, the bridge uses the driver recorded in its saved authentication. If no saved authentication or valid driver is present, it defaults to ACP.

**Images:** Both drivers support image reads through Pi tools. The ACP driver can also automatically load images referenced in user messages. Offloaded image content requires an additional image observer; observer-assisted reads may add latency and model usage. Tool-based reads remain available for images in history and other locations.

**Usage:** Model token usage and account quotas are different measurements. The CLI driver retrieves quota information through `agy --output-format json --print /usage` and displays it in `/agy-bridge:doctor`.

Reported token usage is not a billing total. The bridge does not calculate monetary costs.

### Sessions

The bridge reuses a native session when it matches Pi's history. If Pi branches or compacts a conversation, the bridge can rebuild the model context from Pi's saved messages.

---

## Configuration

### Environment Variables

| Variable | Description |
| :--- | :--- |
| `AGY_ACP_DIR` | Absolute path to a complete ACP Server distribution directory instead of the managed version. Must contain executable `agy_acp_server.par` and `localharness_external` files. |
| `AGY_BRIDGE_DEBUG=1` | Write diagnostic logs to `stderr`. |
| `GEMINI_HOME` | Set the backend state directory. Default: `~/.gemini`. |

For a custom ACP distribution, keep both files in the same directory and set:

```bash
export AGY_ACP_DIR="$HOME/path/to/agy-acp-server"
```

### Managed ACP Server Details

- **Version:** Antigravity ACP Server **1.4.5** (macOS and Linux, x64 and ARM64).
- **Registry:** [`src/extension/drivers/acp/registry.json`](src/extension/drivers/acp/registry.json).
- **Storage:** `<Pi Agent Home>/pi-agy-bridge/acp/<archive-name>/` (typically `~/.pi/agent/pi-agy-bridge/acp/`).
- **Verification:** SHA-256 checksums are verified before extraction.

---

## Troubleshooting

Run `/agy-bridge:doctor` to check the installation, connection, and sign-in status.

### Common Problems

- **ACP download or extraction fails:** Check your network, disk space, and permissions under `~/.pi/agent/`. Downloads are about 93–307 MiB. Linux extraction can require about 1 GiB.
- **Signed out:** Run `/login` and select **Antigravity [pi-agy-bridge]**.
- **No models appear:** Sign in and run `/agy-bridge:doctor`. When offline, the bridge can use a cached model catalog.
- **CLI driver unavailable:** Install `agy` at `~/.local/bin/agy` or add it to your `PATH`, then run `/agy-bridge:doctor`.
- **Custom ACP server fails:** Check that `AGY_ACP_DIR` is an absolute directory path containing executable `agy_acp_server.par` and `localharness_external` files. Unset `AGY_ACP_DIR` to use the managed server.
- **Enable debug logs:**
  ```bash
  export AGY_BRIDGE_DEBUG=1
  pi
  ```

---

## Development

Use [Bun](https://bun.sh) to install dependencies. Use Node.js to run tests:

```bash
# Install dependencies
bun install

# Verify version alignment
bun run check:version

# Run TypeScript type check
bun run typecheck

# Run test suite
bun run test
```

