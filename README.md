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
- **Default ACP backend**: The bridge automatically downloads and verifies the pinned Antigravity ACP server (1.4.4) on first use. No separate ACP installation is required.
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

Startup checks the selected backend without interactive login. CLI uses its headless usage query, which also supplies quota data. ACP opens a temporary session with a browser interceptor: if the server tries to open an authentication page, the bridge reports that login is required and stops the owned process group. Only explicit `/login` permits ACP to open your browser. Successful checks save a driver-scoped bridge credential; an authentication-required result removes it. Network and transport failures remain unknown, not signed out. ACP model discovery uses the same protection and retains cached models when login is required; without a cache, its bundled model catalog remains available.

If startup finds that you are signed out, Pi shows a footer reminder for eight seconds instead of a permanent warning. Successful login clears it immediately. Headless sessions print the reminder once.

To sign in through Pi, run `/login`, select **Antigravity [pi-agy-bridge]**, and follow the authorization prompts.

Your backend tokens remain with the selected backend. Pi stores only a local bridge credential under `agy`, including the driver (`cli` or `acp`) it was checked for. Switching drivers replaces this record after successful verification; it does not keep two login states.

> **Note:** Pi's `/logout` disables the bridge in Pi but does not sign you out of the selected backend. Restarting Pi may enable the bridge again if the backend is still authenticated.

### 3. Choose a Model

Open `/model`, search for `agy`, and select a model labeled `[agy]`. Continue using Pi's tools and commands as usual.

## Driver Selection and CLI Migration

ACP is the fixed default. Executable availability and existing paths do not select a backend. ACP failures never fall back to CLI.

To keep using CLI after upgrading, explicitly switch in Pi:

```text
/agy-bridge:driver cli
/agy-bridge:driver acp
```

Run `/agy-bridge:driver` without arguments to open Pi's driver selection menu, with the current driver marked. Cancel to keep the current driver. Without UI, the command shows status instead. Explicit `cli` or `acp` arguments switch directly. Switching shows progress in Pi's footer and returns a single doctor report after success, without a separate switch confirmation. If Pi's model registry refresh fails after switching, the report includes a warning; the new driver remains selected. A switch applies to the current bridge instance only and is not automatically saved across restart.

Both drivers use `${GEMINI_HOME:-~/.gemini}` as the base directory. Native sessions run in its `antigravity-cli/` or `antigravity-acp/` subdirectory, creating it if needed. Project file access goes through Pi MCP tools, not the native working directory.

## Automatic ACP Installation

The bridge pins **Antigravity ACP Server 1.4.4**. This is not an LTS designation. It supports macOS and Linux on x64 and ARM64; native Windows is not enabled. The complete official snapshot at [`src/extension/drivers/acp/registry.json`](src/extension/drivers/acp/registry.json) is the sole release source. Runtime preparation reads this packaged snapshot, not the remote registry.

- Installation starts when selected ACP needs to launch for an authentication check, model discovery, explicit `/login`, or a conversation request. Startup and doctor can trigger installation; package installation and driver status do not. Pi shows installation progress in its footer; normal progress does not add chat notifications. Installation errors still produce notifications.
- Downloads show MiB and percentage when the server provides a total, followed by verification, extraction, and validation status. Archives are approximately 109–321 MiB; Linux needs about 1 GiB after extraction. Allow additional space for the temporary archive.
- The archive SHA-256 must match the pin before extraction. The complete distribution, including `localharness_external`, retains its executable permissions. Linux launches preserve the required `--uid=` argument.
- Installations live under `<Pi Agent Home>/pi-agy-bridge/acp/<archive filename without .zip>/`, for example `~/.pi/agent/pi-agy-bridge/acp/agy-acp-server-1.4.4-darwin-arm64/`. The archive filename already includes the version. Pi's `getAgentDir()` respects custom Agent Home configuration, including `PI_CODING_AGENT_DIR`; the usual default is `~/.pi/agent`.
- A verified local installation needs no installation network access. Files are hashed on first use in each Pi process; unchanged file identities and metadata permit fast later reuse. Continuing an existing ACP process does not recheck or repair the installation; new process preparation still validates the managed installation. ACP authentication and model requests can still require network access.
- New installations publish only after complete validation. A retry ignores abandoned staging and repairs damaged installations. Concurrent installs reuse a valid published directory; damaged files are repaired atomically from verified staging, with metadata written last. Interrupted repairs must pass validation before use. A valid directory is never replaced or removed.
- Requests within one process share installation work. Separate Pi processes can download concurrently and use unique transient staging directories under the ACP root; publication is atomic. Crash-abandoned staging is not automatically deleted.

`<Pi Agent Home>/pi-agy-bridge/` is the package's persistent data root. The ACP installer manages only its `acp/` subdirectory and leaves sibling data untouched.

### Custom Executable

Set `AGY_ACP_BIN` to an executable path to bypass managed installation and checksum verification. This explicitly trusts that executable and its companion distribution. The background browser interceptor depends on the server honoring Python's `BROWSER` override; a custom server must honor it to provide the same protection. An invalid override is an error; unset it to restore automatic installation. Existing manual installs in `~/.local/opt/agy-acp` or `~/.local/bin/agy_acp_server` now require this override instead of implicit discovery.

### Version Pins and Upgrades

The complete official snapshot in `src/extension/drivers/acp/registry.json` is the sole release source; its upstream source is fixed to [this registry commit](https://github.com/agentclientprotocol/registry/blob/252a92965a33dcbb7704b72bfe9fe387d36f39c2/antigravity-acp/agent.json). `release.ts` only converts the Node architecture key as needed and validates/converts snapshot data. There is no runtime remote fetch. Native Windows is not enabled. The ZIP library is pinned to `yauzl` **3.4.0** (`@types/yauzl` **3.4.0**); `bun.lock` records dependency resolution. No Google binaries are bundled in npm or Git.

Updates require a reviewed PR that replaces the snapshot from a fixed upstream commit, updates its source link, and verifies archive checksums, required files, permissions, and launch arguments. There is no runtime `latest` lookup, automatic patch upgrade, downgrade, or CLI fallback. A changed pin uses the archive-name directory corresponding to the new archive and leaves existing processes untouched. If Google removes a pinned archive, an existing verified local installation still works; new installs must update the bridge or use an explicit custom executable.

## How It Works

One `agy` provider shares model caching, tools, Pi output, and session ownership across both backends. CLI uses Stream JSON; ACP uses its session protocol. Saved session versions prevent incompatible restores across backends. Unsupported older saved formats rebuild from Pi history on the next request; the Pi conversation is preserved.

### Tools and Permissions

The bridge exposes Pi's current tools through a local MCP server. Requests travel from the selected backend through the server and a Unix socket to Pi, where tools run under Pi's policies. Results return along the same path.

Pi also manages custom tools and skills. Pi tool calls execute through the MCP bridge.

The ACP driver requests `enabledTools: []`, denies non-MCP permission requests, and exposes no client write or terminal capability. Unverified ACP tool notifications produce a warning in Pi without stopping the conversation. The warning does not grant permissions or mean execution was prevented. These are configuration and protocol checks, not a sandbox around AGY. Backend enforcement of native-tool filtering and system-instruction delivery still needs real-backend validation.

ACP notifications are observational, not execution or authorization evidence. A notification titled `Running client_view_file` with kind `read` and no MCP identity is classified as Client Read without requiring a matching RPC, so it does not produce a tool warning. This does not prove that a read occurred, succeeded, or was authorized. Every actual Client Read request still passes through the restricted Artifact Reader; a rejected read does not by itself require a tool warning.

### Sessions and Context

The bridge reuses your selected-backend conversation across turns and can resume it after restarting Pi when the history still matches.

Switching Antigravity models preserves the conversation. If tools are still running, the model change applies to the next request.

After compaction, branching, a response from another provider, or a failed restore, the bridge starts a new conversation from Pi's current instructions and history. Your Pi session remains unchanged.

ACP resolves Pi's current system instructions, including section updates and removals, and sends them with ACP-specific integration instructions through Antigravity's system-prompt append extension. The server must advertise support for this extension. Instruction changes rebuild the ACP conversation, including during a tool handoff; completed Pi tool results remain history and are not executed again. Saved references must match the native working directory and, for ACP, the current instructions. CLI instruction handling is unchanged.

### Model Discovery

The bridge reads the selected backend's model catalog and caches it in Pi across restarts. If a refresh fails, it retains the cached catalog. Your Pi model overrides take precedence over the bridge's defaults.

### Token Usage

The bridge reports token usage from the latest model request, not the conversation's accumulated totals. The context count includes cache-read tokens so Pi can use it for context display and automatic compaction.

### Cancellation and Errors

Cancelling a request stops the selected runtime and closes the MCP connection. For CLI, if the process does not initialize within 30 seconds, the bridge terminates it and reports an error to Pi.

After a quota error, you can select another Antigravity model and retry. The bridge reuses the conversation when it is safe to do so; it does not automatically resend failed requests.

If a runtime or tool failure makes the conversation unsafe to reuse, the next request rebuilds context from Pi history.

## Troubleshooting

Run `/agy-bridge:doctor` in Pi for a shared report of the selected backend's version, Node, Pi MCP bridge entrypoint, models, and authentication. Pi's footer shows the latest active command's progress. When that command finishes, it restores any earlier pending operation's status or clears the status if none remain. Version checks use `--version`; ACP omits the version if no build label is reported. CLI also reports plugin status and queries quota on demand; a successful query confirms authentication. ACP actively checks authentication through `session/new` on every doctor invocation, sharing a check already in progress. An explicit authentication-required response reports `unauthenticated`; transport, timeout, and other check failures report `unknown` with diagnostic details. The check never calls `authenticate` or prompts for login. Doctor synchronizes the same driver-tagged bridge credential as startup. If authentication is required, its report includes `/login` instructions without a second notification. A successful session check does not guarantee that a later model request will succeed. ACP displays `Quota remaining (unavailable)`.

- **ACP unavailable**: Read the installation error and check network access, free disk space, and cache directory permissions. For a custom `AGY_ACP_BIN`, check its path and executable permissions or unset it to use automatic installation. Failures never choose CLI; fix ACP or explicitly run `/agy-bridge:driver cli`.
- **Unauthenticated models**: Default ACP model entries or cached models may appear before login; their presence does not confirm authentication, connectivity, or request success. Run `/login` for the selected backend.
- **Missing models**: Retry `/login` and `/model`, then inspect doctor output. For explicitly selected CLI, `agy models` checks availability directly.
- **Sign-in failures**: Retry `/login`; if ACP requires unsupported terminal authentication, authenticate externally and retry. For CLI, sign in using `agy` in a terminal.
- **Restricted ACP reads**: Client reads only allow the active conversation's offloaded artifacts and registered Pi MCP tool schemas/instructions. Workspace reads still use Pi tools. The reader uses canonical paths, symlink rejection, and file/directory change checks; it trusts the local directory owner and is not a sandbox against a hostile same-user process.
- **Paged artifact text**: Responses contain source text, not an inner JSON envelope. When more lines remain, a trailing notice gives the line range and `start_line=N` continuation hint for the advertised client reader. Pages contain at most 256 lines and a conservatively measured 24 KiB of serialized response including the notice; overlong individual lines fail explicitly. ACP transport uses 1-based `line` and `limit`, not Pi read's `offset`. Pages use an immutable snapshot for each native prompt.
- **Image observations**: Original workspace images use Pi tools; current-conversation offload artifacts use the available ACP client reader. Authorized image artifacts are sent as image content to a separate, tool-free ACP session using the selected model and original user objective. It returns descriptions, full legible transcription, and answers as derived text for the main agent's answer. This makes an additional model request; observer lifetime is limited to 60 seconds. Real-backend end-to-end validation is not claimed.
- **Read diagnostics**: With `AGY_BRIDGE_DEBUG=1`, `acp-read` logs identify completed client reads and image observer start/completion. These entries record paths and sizes, not image contents; a generated answer alone does not prove the observer ran.

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
