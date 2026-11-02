# Direct AGY ACP contract diagnostic

`bun run check:acp` sends requests directly to AGY ACP with fixed
`gemini-3.8-flash`, mode `default`, and effort `low`. It does not start Pi,
a provider, or a live harness. Tool restriction and genuine text offload/Client
Read checks are part of the default diagnostic; their live evidence is pending.

## Invocation and boundaries

```sh
bun run check:acp
```

No environment flags or model matrix are required. Prepare backend authentication
externally. The pinned managed backend must already be installed by Bridge.
The diagnostic validates and reuses it; it never downloads or repairs a backend.
Invocation opts into billable prompts and possible host backend state writes;
cancellation does not guarantee zero cost.
`--cancel` optionally adds an activity-gated cancellation check. `--help` is offline
and does not install, launch a backend, or send prompts.

The script uses production raw `Connection` and the existing managed installation
under the normal Pi agent directory: `PI_CODING_AGENT_DIR`, or `~/.pi/agent` by default.
Production inventory/hash validation is reused with downloads explicitly disabled.
Missing or invalid installations fail with `ACP_INSTALL_REQUIRED` or
`ACP_INSTALL_INVALID` before backend launch; install/repair through Bridge separately.
Existing host HOME/GEMINI_HOME and authentication are reused; the script does not
read/copy tokens, log in, log out, or delete credentials.
The whole-run deadline is 15 minutes plus at most 5 seconds for cleanup; prompts have
60 seconds, or 120 seconds for each bulk offload attempt.

Temporary project scratch does not isolate backend cache, sessions, or artifacts. Cleanup does not roll back host backend state. Path checks and disabled
native tools are not an OS sandbox or a guarantee against a hostile same-UID process.

## Basic direct ACP checks

- Inspect advertised `systemPrompt.append` support and send instructions through
  `_meta.antigravity.systemPrompt.append` on session creation.
- Verify actual mode/model/effort configuration responses, instruction delivery,
  and same-session memory without repeating the hidden value.
- Send one tiny red pixel directly and check its answer. This is only direct image
  input; image offload remains `UNTESTED`.
- Capture raw allowlisted final usage and separate `usage_update` fields. Missing
  usage is `null`, not zero or a usage PASS; neither source proves billing totals.
- Attempt load only when advertised; otherwise report `NOT_SUPPORTED`.
- With `--cancel`, require observed activity while a prompt is still pending before
  cancellation. Missing that boundary is not a cancellation pass.

## Tool restrictions and real data source

`scripts/acp-probe-mcp.ts` is a minimal real stdio MCP data source, registered as
`pi-agy-bridge_pi` with one empty-arguments tool, `mcp__pi__offload_probe`.
It generates a fresh handler-only receipt solely at the result tail and writes a
private execution audit. It does not create AGY artifacts or implement offload.

The default restriction challenge requests a small, roughly 64-byte-class result
and sends `enabledTools: []`. It asks for a native write to a scratch canary, then
MCP recovery. Only the registered MCP tool may receive `allow_once`; other permission
requests are denied. Actual tool and permission notifications, the execution audit,
recovered receipt, and unchanged canary are checked.

An unchanged canary plus successful MCP recovery without an actual native permission
attempt is `NOT_REACHED`, not an enforcement PASS. Configuration alone proves neither
a denied operation nor confinement.

## Genuine text offload and Client Read

Bulk attempts request 64 KiB, 256 KiB, 1 MiB, then 4 MiB, stopping at actual offload.
Each attempt gets a new source and session. A source permits at most two successful
calls to expose retry while bounding amplification; the diagnostic requires exactly
one audited execution. Prompts, seeded files, and invented references are not evidence.

The text-only reader accepts only current-session generated steps and exact MCP
metadata paths. It rejects other paths and unsafe files, uses immutable bounded
snapshots/pages and the production `start_line` continuation footer. AGY may read
its own tool metadata before execution; each callback records the execution count.
Such reads cannot prove result offload. Recovery must match the tail receipt from
exactly one actual MCP execution.

Client Read PASS requires an observed offload reference/read, an AGY artifact
containing the handler-only receipt, an actual first-page RPC followed by a later
RPC using that same artifact's advertised continuation, the receipt in an actual
read response tail, and that receipt in the model's final answer. Metadata reads
alone do not qualify.

No offload within the tested bounds is `NOT_REACHED`. A core tool/offload/read check
left `NOT_REACHED` makes the outcome `INCOMPLETE`. Reached read errors or assertion
failures are `FAIL`, not a reason to retry larger payloads. Model-answer mismatches
are recorded separately as `MODEL_MISMATCH` and prevent a successful outcome.

## Reports, cleanup, and evidence

Private JSON reports retain backend/configuration facts, raw allowlisted usage,
compact tool/permission/read/artifact facts and execution hashes, not full result
payloads, auth payloads, backend stderr, or a full RPC trace. Review before sharing.
The script prints the current RPC/stage and a waiting heartbeat every 10 seconds.
The private report exists from startup and is updated while `RUNNING`, including
current progress and safe error codes/cause codes. Raw exception messages, auth
payloads, inherited environment and backend stderr are not printed.

Owned connections and project scratch are cleaned up on success or failure;
the report and existing managed installation are retained. Validation teardown is
joined before scratch removal. Cleanup deadline expiry is FAIL with possible
retained scratch, not a claim of removal.

The prior basic direct ACP live run against 1.4.5 passed configuration, instruction,
memory, red-pixel input, load, and cleanup checks; raw usage was observed. The new
tool restriction, text offload, and Client Read path has not been verified live.
The user's existing managed ACP 1.4.5 passed read-only validation without download
or backend startup after the reuse change.
Offline tests/typechecking are separate evidence, not live compatibility proof;
the current offline suite reports 2,176 PASS, 13 SKIP and zero failures. Pi/provider integration, history
reconstruction, compaction, Pi accounting, and image offload are outside this scope.
