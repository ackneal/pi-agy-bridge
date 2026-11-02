# pi-agy-bridge

[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)]()
[![Pi Extension](https://img.shields.io/badge/pi-extension-purple.svg)](https://github.com/earendil-works/pi-coding-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Use Antigravity models in Pi without changing how Pi works.**

Use Antigravity models with [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) through Google's official ACP server. Keep your Pi tools, extensions, skills, and session history. An optional CLI driver is also available.

---

## Architecture

**Pi runs the agent. Antigravity provides the models.**

```text
Pi Coding Agent
  |  Prompts and session context
  v
pi-agy-bridge (ACP or CLI)
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

The bridge connects Antigravity models to Pi. Pi manages the conversation and executes registered tools. The selected driver controls how the bridge communicates with Antigravity.

---

## Features

- **Native Pi Experience** — Keep Pi tools, extensions, skills, and session history.
- **Pi Tool Integration** — Run registered tool requests through Pi with its applicable permissions.
- **Two Drivers** — Use the managed ACP server or your installed `agy` CLI.
- **Session Continuity** — Reuse compatible sessions. Restore context from Pi history when needed.
- **Image Support** — Read images through Pi tools, with automatic image injection for ACP.
- **Automatic ACP Setup** — Download and verify the pinned ACP server.
- **Diagnostics** — Check your setup with `/agy-bridge:doctor`.

---

## Requirements

| Requirement | Details |
| :--- | :--- |
| **Operating System** | macOS or Linux. Native Windows is not supported. |
| **Pi Coding Agent** | `@earendil-works/pi-coding-agent`. |
| **ACP Backend (Default)** | The bridge installs the ACP server automatically. |
| **CLI Backend (Optional)** | Install `agy` at `~/.local/bin/agy` or add it to your `PATH`. |

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

| | ACP (default) | CLI (optional) |
| :--- | :--- | :--- |
| Setup | Installed automatically | Requires `agy` |
| Models | ACP model catalog | CLI model catalog |
| Tool integration | Pi tools through MCP | Pi tools through the CLI integration |
| Image reads | Tool reads with image observer | Tool reads |
| Image injection | Automatically injects images referenced in user messages | — |
| Usage | Prompt-level reporting | Step-level reporting |

Use `/agy-bridge:driver` to change the driver. Use `/model` to see its available models. On startup, the bridge uses the driver recorded in its saved authentication. If no saved authentication or valid driver is present, it defaults to ACP.

**Images:** Both drivers support tool-based image reads. ACP also uses an image observer for eligible offloaded images. The observer returns text and may add latency and model usage.

For images referenced in user messages, ACP can automatically inject image blocks into the model prompt. Tool-based reads remain available for images in history and other locations.

**Usage:** ACP and CLI report usage at different levels. Do not compare their values as billing totals. The bridge does not calculate monetary costs.

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

The pinned Pi packages in `devDependencies` are for local checks only; Pi provides them when loading an installed package.

These commands preserve the existing package scripts: typechecking uses TypeScript, and the test suite uses Node.js with `node:test` and type stripping, not Bun's test runner. A Node.js version supporting the test script's flags is required.

The direct AGY ACP diagnostic uses `bun run check:acp` with fixed `gemini-3.8-flash` / `low`, no environment flags, and optional `--cancel`; invocation opts into downloads, billable prompts, and host backend state writes. `--help` is offline. Default checks cover native tool restrictions and genuine MCP text offload/Client Read, not Pi, a provider, or a harness. No native permission attempt or offload means `NOT_REACHED`, not enforcement/recovery PASS; core checks not reached leave the outcome `INCOMPLETE`. The prior basic direct ACP 1.4.5 run passed configuration, instruction, memory, red-pixel input, load, and cleanup with raw usage observed; the new tool/offload/read path has not run live, and image offload remains `UNTESTED`. Offline checks are separate evidence. This is not a sandbox or a hostile same-UID safety guarantee; host backend state is not rolled back. See [the diagnostic contract and verification status](docs/live-acp.md) for bounded probes, private reports, and deadlines.
