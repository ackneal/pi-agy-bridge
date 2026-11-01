# pi-agy-bridge

[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)]()
[![Pi Extension](https://img.shields.io/badge/pi-extension-purple.svg)](https://github.com/earendil-works/pi-coding-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Bridge Google Antigravity models into [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent), while keeping tool execution, user permissions, and session history strictly under Pi's control.

---

## Design Concept & Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Pi Coding Agent                        │
│     • User Interface & Interaction                          │
│     • Tool Execution Engine & Permission Policies           │
│     • Conversation History & Context Compaction             │
└──────────────┬──────────────────────────────▲───────────────┘
               │                              │
          Unix Socket                    Child Process
              IPC                            Stdio
       (Tool Execution)               (Prompts / Model Stream)
               │                              │
┌──────────────▼──────────────┐               │
│     pi-agy-bridge-mcp       │               │
│   (Local MCP Bridge Server) │               │
└──────────────▲──────────────┘               │
               │                              │
           MCP Stdio                          │
      (tools/call & results)                  │
               │                              │
┌──────────────┴──────────────────────────────┴───────────────┐
│                     Antigravity Backend                     │
│        • ACP Driver (Default): Agent Client Protocol        │
│        • CLI Driver (Optional): `agy` Stream JSON           │
└─────────────────────────────────────────────────────────────┘
```

### Why pi-agy-bridge?

Antigravity provides state-of-the-art reasoning models, but developers often prefer Pi's lightweight TUI, native command execution, flexible extensions, and strict permission models.

`pi-agy-bridge` bridges both worlds through **inversion of tool control**:
- **Antigravity acts purely as the model runtime**: It generates completions and requests tool calls. It does not access your workspace directly or execute local commands.
- **Pi manages execution and policy**: Every tool call (file read/write, bash, git, custom extensions) routes through a local Model Context Protocol (MCP) server back into Pi's engine. Pi's permission checks, sandboxing, and user approvals remain authoritative.
- **Native authentication**: The bridge delegates authentication to the selected backend without handling or persisting external API keys directly in Pi.
- **Seamless context synchronization**: Session continuity across turns and restarts, with transparent context reconstruction whenever Pi compacts or branches history.

---

## Features

- **Automatic ACP Setup**: Automatically downloads, validates (SHA-256), and manages the pinned official Antigravity ACP server (1.4.4) on macOS and Linux. Zero manual installation needed.
- **Dual Driver Architecture**:
  - **ACP (Default)**: Fast, structured JSON-RPC over stdio via the Agent Client Protocol. Includes browser-interception to prevent unexpected popup logins.
  - **CLI (Optional)**: Connects to your existing local `agy` CLI binary.
- **Full MCP Tool Inversion**: Antigravity models call your workspace tools, bash commands, and Pi extensions through a dedicated Unix domain socket MCP bridge.
- **Session Continuity & Native Compaction**: Conversations persist across turns and restarts. When Pi branches, switches providers, or compacts context, the bridge rebuilds context transparently.
- **Accurate Token Accounting**: Reports per-turn prompt, completion, and cache-read tokens directly to Pi for status bar tracking and automatic context compaction.
- **Built-in Diagnostics**: `/agy-bridge:doctor` provides real-time verification of driver health, binaries, socket paths, model catalogs, and auth status.

---

## Requirements

| Requirement | Details |
| :--- | :--- |
| **Operating System** | macOS or Linux with Unix domain socket support (Native Windows is not supported). |
| **Pi Coding Agent** | `@earendil-works/pi-coding-agent` (Node.js runtime supported by Pi). |
| **ACP Backend (Default)** | Managed automatically by the bridge (no manual download required). |
| **CLI Backend (Optional)** | `agy` binary installed at `~/.local/bin/agy` or in your `PATH`. |

---

## Quick Start

### 1. Install the Extension

Install directly via Pi package manager:

```bash
pi install npm:@ackneal/pi-agy-bridge
```

Or install from GitHub:

```bash
pi install git:github.com/ackneal/pi-agy-bridge
```

### 2. Sign In

1. In Pi, run:
   ```text
   /login
   ```
2. Select **Antigravity [pi-agy-bridge]** from the provider list.
3. Follow the authorization prompt in your browser.

> **Note on Background Checks**: Startup and doctor checks are completely headless and will never launch your browser automatically. Only an explicit `/login` triggers the authentication flow.

### 3. Select a Model

1. Open Pi's model selector:
   ```text
   /model
   ```
2. Type `agy` to filter available Antigravity models (e.g., `gemini-3.8-flash [agy]`, `gemini-4-argon [agy]`, `gemini-3.1-pro [agy]`).
3. Select your model and start chatting as normal. All standard Pi tools and skills work out of the box.

---

## Command Reference

| Command | Description |
| :--- | :--- |
| `/login` | Authenticate with Antigravity via Pi's standard provider login flow. |
| `/model` | Search and switch between available Antigravity models. |
| `/agy-bridge:driver` | Open interactive menu to select or switch the Antigravity driver (`acp` or `cli`). |
| `/agy-bridge:doctor` | Run health checks on driver status, binary paths, socket IPC, auth, and model discovery. |

---

## How It Works

### Tool Boundaries
- **Strict Boundary Control**: Antigravity acts purely as the model runtime. It cannot directly read workspace files, modify your code, or run shell commands.
- **Pi Policy Enforcement**: All tool calls are routed through the bridge back to Pi. Every action runs through Pi's tools, subject to Pi's permission policies and user approvals.

### Artifact Reader for AGY Offloads
- **Offloaded Output Handling**: When Antigravity's behavior offloads large tool results, transcripts, or execution steps to disk, the model needs to inspect them.
- **Restricted Access**: The bridge provides a dedicated Artifact Reader (`client_view_file`) strictly scoped to current-turn offload artifacts (under `.system_generated/steps/`) and registered tool schemas.
- **Host Protection**: Arbitrary filesystem reads, directory traversal, and symlink escapes outside the designated offload directory are rejected.
- **Image Offloads**: Offloaded image artifacts are processed via an isolated, tool-free subsession observer.

### Session Continuity & Context Reconstruction
- **Turn Continuity**: Conversations persist across turns and restarts as long as history matches.
- **Transparent Reconstruction**: When Pi branches, switches models, or performs context compaction, the bridge automatically reconstructs the conversation from Pi's message log to keep both runtimes synchronized.
- **Token Accounting**: Real-time token usage (including cache reads) feeds directly into Pi for context monitoring and automatic compaction.

---

## Configuration

### Environment Variables

| Variable | Description |
| :--- | :--- |
| `AGY_ACP_BIN` | Path to a custom Antigravity ACP server executable. Overrides automatic download and verification. |
| `AGY_BRIDGE_DEBUG=1` | Enables diagnostic logging to `stderr` with `[Antigravity CLI:...]` tags. |
| `GEMINI_HOME` | Base directory for backend runtime state (defaults to `~/.gemini`). |

### Managed ACP Server Details

- **Pinned Version**: Antigravity ACP Server **1.4.4** (macOS & Linux, x64 and ARM64).
- **Snapshot Source**: Packaged in [`src/extension/drivers/acp/registry.json`](src/extension/drivers/acp/registry.json).
- **Storage Location**: `<Pi Agent Home>/pi-agy-bridge/acp/<archive-name>/` (typically `~/.pi/agent/pi-agy-bridge/acp/`).
- **Integrity**: Verified against pinned SHA-256 checksums before atomic extraction.

---

## Troubleshooting

Run `/agy-bridge:doctor` in Pi to diagnose connection, authentication, or installation issues.

### Common Issues

- **ACP Download / Extraction Fails**: Check network access and disk space (approx. 109–321 MiB download; Linux needs ~1 GiB extracted). Verify directory permissions under `~/.pi/agent/`.
- **Signed Out Reminder**: Run `/login` and select **Antigravity [pi-agy-bridge]**.
- **Model Catalog Empty**: Ensure you are authenticated. Run `/agy-bridge:doctor` to verify model discovery. If offline, the bridge falls back to cached catalogs.
- **Custom Executable Not Working**: If using `AGY_ACP_BIN`, ensure the binary has execute permissions (`chmod +x <path>`) and supports the Agent Client Protocol. Unset `AGY_ACP_BIN` to return to the managed server.
- **Enabling Debug Logs**:
  ```bash
  export AGY_BRIDGE_DEBUG=1
  pi
  ```

---

## Development

This repository uses [Bun](https://bun.sh) for package management and Node.js for tests:

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

---

## License

[MIT](LICENSE)
