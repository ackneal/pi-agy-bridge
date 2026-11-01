# pi-agy-bridge

[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)]()
[![Pi Extension](https://img.shields.io/badge/pi-extension-purple.svg)](https://github.com/earendil-works/pi-coding-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Use Antigravity models in Pi without changing how Pi works.**

A deeply integrated Antigravity model bridge for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent). Use your existing Pi tools, extensions, skills, permissions, and session history.

---

## Design Concept & Architecture

```text
┌───────────────────────────────────────────────────────────────┐
│                       Pi Coding Agent                         │
│   • Terminal UI & Session History                             │
│   • Tool Execution Engine (Bash, Read, Write, Edit, Custom)   │
│   • Sandbox & Permission Policy Checks                        │
└───────────────▲───────────────────────────────┬───────────────┘
                │                               │
       [Unix Domain Socket]            [Process Stdio]
        • Relays tool requests          • Sends user prompts
        • Returns tool execution        • Streams reasoning &
          results to model                completion tokens
                │                               │
┌───────────────▼───────────────┐               │
│       pi-agy-bridge-mcp       │               │
│     (Local MCP Adapter)       │               │
└───────────────▲───────────────┘               │
                │                               │
          [MCP Stdio]                           │
        • tools/call                            │
                │                               │
┌───────────────┴───────────────────────────────▼───────────────┐
│                      Antigravity Backend                      │
│            • ACP Driver (Default) / CLI Driver (`agy`)        │
│            • Model Reasoning & Inference                      │
└───────────────────────────────────────────────────────────────┘
```

### Why pi-agy-bridge?

**Pi stays in control. Antigravity provides the models.**

Rather than replacing Pi's agent environment, pi-agy-bridge connects Antigravity model inference to the Pi harness you already use.

- **Deep Pi integration**: Keep your existing tools, extensions, skills, and session history.
- **Pi-controlled workspace operations**: The bridge exposes Pi tools over MCP and routes their execution back through Pi's tools and applicable permission policies.
- **Restricted native capabilities**: Each driver applies its own restrictions to Antigravity's native tools. ACP also provides limited access to AGY-managed artifacts through a dedicated reader.
- **Native backend authentication**: Sign-in is handled by the selected Antigravity backend; the bridge does not manage separate API keys.



---

## Features

- **Deep Pi Integration** — Use Antigravity models in your existing Pi environment, including native tools, custom extensions, skills, and sessions.
- **Pi-Controlled Tool Execution** — Route workspace tool requests through Pi's MCP bridge, where Pi executes tools under its applicable policies.
- **ACP & CLI Drivers** — Choose the managed ACP backend (default) or an installed Antigravity CLI. Available models and capabilities differ by driver.
- **Session Continuity** — Reuse compatible native sessions across turns and reconstruct context from Pi history when needed, including after branching or compaction.
- **ACP Image Support** — Deliver supported user images as prompt image blocks. Analyze supported images encountered through artifact reads with an isolated image observer.
- **Automatic ACP Setup** — Download and verify the pinned Antigravity ACP server on macOS and Linux.
- **Built-in Diagnostics** — Use `/agy-bridge:doctor` to check driver setup, authentication, and model discovery.

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
3. Select your model and start chatting as normal. Your existing Pi tools and skills remain available.

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

### Tool Execution & Permissions

Pi remains the primary agent harness. The bridge exposes the Pi session's tools through a local MCP adapter; Antigravity requests those tools, and Pi executes them using its existing tool environment and applicable permission policies.

The drivers restrict Antigravity's native tool capabilities in different ways:

- **ACP** — Configures an empty native-tool allowlist, handles permission requests through ACP, and exposes registered Pi tools over MCP. A dedicated reader allows limited access to AGY-managed artifacts.
- **CLI** — Uses its CLI plugin and tool restrictions to direct supported workspace operations through Pi, with monitoring of reported tool activity.

These mechanisms describe how the integration restricts tool use; they do not claim operating-system sandbox isolation.

### Driver Differences

| Capability | ACP (default) | CLI (optional) |
| :--- | :--- | :--- |
| Setup | Managed, verified ACP server | Existing `agy` installation |
| Models | Models exposed by the ACP catalog | CLI catalog, including additional Claude and GPT-OSS options |
| User images | Image blocks in the main ACP prompt | Text-only prompt serialization; no equivalent image-block path |
| Tool-read images | Restricted artifact reader and image observer | No equivalent observer path |
| Usage reporting | Context snapshots and prompt-response accounting | Step-level usage snapshots |

Available models depend on the backend and its catalog. Use `/model` to see the current options and `/agy-bridge:driver` to switch drivers.

### ACP Image Handling

**User-provided images:** The bridge detects supported image references in user text and accepts image content blocks, then includes the image data in the main ACP prompt.

**Images encountered through artifact reads:** Images returned through the existing MCP/tool-result or client-read paths cannot be passed into the main ACP conversation as new image blocks. Instead, a restricted Artifact Reader loads eligible AGY-managed artifacts and starts an isolated, tool-free image observer. The observer receives the image in a separate prompt and returns derived text to the main conversation.

Observer analysis requires an additional model request, which can add latency and usage. The main agent receives the observer's interpretation rather than the original image block.

The Artifact Reader limits reads to permitted AGY-generated artifacts and registered tool metadata. It rejects unsupported paths and symlink-based escapes; it does not provide unrestricted workspace access.

### Session Continuity & Context Reconstruction

The bridge reuses native conversations while their state remains compatible with Pi's history. When a native session cannot be reused—for example, after a branch, provider change, or context compaction—it reconstructs the relevant conversation from Pi messages, including tool execution outcomes.

Both drivers report context usage to Pi, but their measurements differ: ACP provides prompt-response accounting and context snapshots, while CLI reports step-level snapshots. They should not be treated as directly comparable billing totals; monetary costs are not calculated from provider prices.

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

