# Live ACP upgrade regression checklist

Use this opt-in checklist when upgrading the managed AGY backend, ACP SDK or Pi dependencies. It tests Bridge adaptations, not generic ACP lifecycle compliance. No authenticated live results are established here; offline checks and skipped runs are not compatibility passes.

## Sources and prerequisites

`tests/live/scenarios.ts` defines scenario IDs and core/extended selection. `tests/live/acp.live.ts` owns setup, selection and execution; `auth.ts`, `tool-handoff.ts`, `images.ts`, `text-offload.ts` and `compaction.ts` implement specialized cases. `pi-session.ts` supplies the real Pi/Bridge harness; `report.ts` defines evidence and outcomes.

Production references are `src/extension/drivers/acp/` for installation, authentication, configuration, permissions, artifact reads and image observation, and `src/extension/session/` plus `src/extension/provider/` for history reconstruction and compaction. The pinned release and checksums come from `registry.json` through `release.ts` and `installation.ts`; do not substitute a host binary. Deterministic `*.test.ts` fixtures cover edge cases but never substitute for reached live paths.

Run only in a dedicated disposable Linux container on a supported managed architecture, with Node supporting `--experimental-transform-types`, Bun, repository dependencies and network access. The hard gate requires `PI_AGY_LIVE=1` and `PI_AGY_LIVE_ISOLATED=1`, attesting that no host directories, credentials or keyring are mounted. These assertions and path checks do not create an OS sandbox. This checklist does not authorize using a real user's environment.

Prepare `PI_AGY_LIVE_WORKSPACE` externally as an absolute, real, current-user-owned directory below the container's temporary directory, with real `home/` and `gemini/` directories. The runner sets `HOME` and `GEMINI_HOME` there, puts Pi agent state and the pinned managed installation in fresh scratch storage, and clears executable overrides and alternate credential/configuration environment variables. `PI_AGY_LIVE_INSTALL=1` separately consents to the download.

## Authentication and cost consent

`PI_AGY_LIVE_AUTH_STATE` defaults to `authenticated`: prepare backend authentication externally in this disposable environment through the supported backend login flow. For `AUTH-noauth`, independently prepare a dedicated unauthenticated environment and set `PI_AGY_LIVE_AUTH_STATE=unauthenticated`. Never log out, delete credentials or copy tokens to manufacture either state; never hardcode credentials or log tokens.

Setup installs without a blanket authenticated probe, allowing negative-auth cases to run. Non-auth scenarios cache a noninteractive production auth probe, skip when authentication is unavailable, and skip in an explicitly unauthenticated run. Auth scenarios invalidate that cache and check their own prerequisites.

`AUTH-login` and `AUTH-login-cancel` additionally require `PI_AGY_LIVE_LOGIN=1`, consenting to backend browser interaction and disposable credential-state changes, plus `PI_AGY_LIVE_AUTH_METHOD` set to an exact backend-advertised method ID. There is no automatic method selection. An empty auth UI can make the chooser/cancellation boundary unreachable; report `INCONCLUSIVE`, not a cancellation pass.

Downloads, prompts, retries, image observers, offload size sweeps and compaction consume network and may incur account charges. Cancellation does not guarantee zero billing. Use disposable data and a sufficient deadline, especially for multi-runtime compaction and bounded offload sweeps.

## Commands and selection

```sh
# Inside the externally prepared disposable Linux container only:
PI_AGY_LIVE=1 PI_AGY_LIVE_ISOLATED=1 PI_AGY_LIVE_INSTALL=1 \
PI_AGY_LIVE_WORKSPACE=/tmp/acp-live-workspace \
bun run test:live:acp

# Independent negative-auth environment; do not alter authenticated credentials:
PI_AGY_LIVE=1 PI_AGY_LIVE_ISOLATED=1 PI_AGY_LIVE_INSTALL=1 \
PI_AGY_LIVE_WORKSPACE=/tmp/acp-live-noauth \
PI_AGY_LIVE_AUTH_STATE=unauthenticated PI_AGY_LIVE_SCENARIOS=AUTH-noauth \
bun run test:live:acp
```

| Control | Meaning |
| --- | --- |
| `PI_AGY_LIVE_SCENARIOS` | Comma-separated exact IDs; selects only those cases, including explicitly named extended cases. Unknown IDs fail. |
| `PI_AGY_LIVE_EXTENDED=1` | Include extended cases when no explicit selection is supplied. |
| `PI_AGY_LIVE_TIMEOUT_MS` | Positive per-scenario deadline; default `120000` ms. |
| `PI_AGY_LIVE_MODEL` | Supported ACP model ID; default `gemini-3.1-pro`. |
| `PI_AGY_LIVE_EFFORT` | Optional `low`, `medium` or `high`; configuration case verifies the thinking setting. |
| `PI_AGY_LIVE_REPORT_DIR` | Existing fresh owned directory below the OS temporary directory, outside the workspace; otherwise a new temporary directory is created. Reports are not overwritten. |

The default selection is core only; login cases still require their additional consent. To exercise login, explicitly select `AUTH-login` or `AUTH-login-cancel` and supply both login controls above. Use separate prepared environments for positive and negative auth rather than expecting one run to prove both.

## Core regression matrix

| Scenario | Goal | Evidence | Current limit |
| --- | --- | --- | --- |
| `AUTH-probe` | Noninteractive authenticated probe | Production probe returns true, successful `session/new`, actual subprocess `BROWSER` blocker, noninteractive mode and disposed connection. | Requires authenticated state; does not prove an attempted browser launch was blocked. |
| `AUTH-noauth` | Noninteractive negative auth | Production probe returns false, noninteractive launch and cleanup. | Independently prepared unauthenticated state only; transport failure is not negative-auth evidence. |
| `AUTH-login` | Real Pi `/login` integration | Advertised chooser selection, interactive launch, one successful `authenticate`, subsequent `session/new` and probe, cleanup. | Extra consent and exact method required; no chooser is inconclusive. |
| `AUTH-login-cancel` | Cancel at method selection | Pending chooser reached; only the abort signal rejects login, zero `authenticate` calls, natural disposal and a follow-up probe preserving the actually observed pre-cancel state. | Empty/no chooser can be unreachable; no full browser-flow cancellation claim. |
| `CONFIG-instructions` | Bridge instructions/configuration | Actual `session/new` contains `systemPrompt.append`; handler uses its hidden value; configuration RPC responses confirm mode, model and optional effort. | Effort tested only when supplied; backend/account must support selected values. |
| `B-native` | Native/Pi tool boundary | `enabledTools: []`, actual non-MCP permission denied, warning event, allowed Pi call and unchanged independent canary. | No native permission attempt means inconclusive; not proof of OS confinement or UI warning rendering. |
| `A-success`, `A-error` | Real Pi MCP result handoff | Persisted assistant/result IDs and arguments match execution; handler-only receipt returns through AGY; error case has `isError: true`; turn completes. | Model must execute the exact call; Pi and ACP IDs are distinct by design. |
| `READ-scope` | Seeded Client Read safety | Actual RPCs allow current-session text/image and reject outside, cross-session, symlink and invalid paths; actual read responses and image observer completion. | Missing subcases are inconclusive. Seeded files never count as offload; best-effort same-UID checks are not a sandbox. |
| `IMG-prompt-small`, `IMG-prompt-large` | Direct prompt image transport | Actual main `session/prompt` carries exact PNG/MIME; byte/hash evidence and final transcription of image-only digits. | Pi helper disables resizing. Large prompt uses a 4 MiB, 2496×1231 PNG, mostly real encoded pixels rather than padding; this tests backend handling, not Pi transforms. |
| `IMG-mcp-small` | Real Pi image result | Exactly one Pi execution; persisted exact image result, observed inline/offload route and final visual marker. | Small size does not guarantee an inline route; any observed offload must satisfy recovery assertions. |
| `IMG-mcp-offload` | Actual AGY image offload/recovery | Real tool image, notified current-session artifact, exact artifact hash, actual Client Read response, independent observer prompt with exact bytes and derived marker, final answer; no replay. | Bounded requested-size sweep: 32 KiB, 256 KiB, 1 MiB, 4 MiB. No offload across bounds is inconclusive, not a threshold claim. |
| `OFFLOAD-text` | Actual AGY text offload/paging | One real Pi tool execution per attempt; current-session reference/read, first-page continuation, follow-up RPC on same path at advertised line, tail in actual read response and final answer. | Bounded requested-size sweep: 64 KiB, 256 KiB, 1 MiB, 4 MiB; actual text size differs. No offload is inconclusive. |
| `G-compaction` | Real Pi compaction continuity | `AgentSession.compact()`, standalone preparation with no tools/MCP, separate summary runtime, persisted/projected summary, fresh-runtime reconstruction and new real Pi receipt using summary-only context; no completed-tool replay. | Disables automatic compaction and keeps minimal recent context; requires several turns. Not interactive startup coverage. |
| `F-pending` | Cancel pending MCP ownership | Pending call and active prompt observed, actual cancel RPC while active, stopped process/empty broker, fresh-runtime successful probe. | Boundary missed before turn ends is inconclusive; driver/runtime cancellation, not full ProviderTurn UI cancellation. |
| `C-lifecycle` | Short two-turn smoke | First turn learns marker; second uses it in a Pi call with unchanged session ID and no reconstruction. | Continuation only; no disk resume/load or rebuild claim. |

## Extended matrix

Run these only with `PI_AGY_LIVE_EXTENDED=1` or explicit scenario selection.

| Scenario | Goal | Evidence | Current limit |
| --- | --- | --- | --- |
| `D-rebuild` | Pi context reconstruction | Persisted history restored, actual failed load of injected unavailable checkpoint, fresh ordered reconstruction; changed instructions trigger another rebuild; exact new call counts exclude completed-tool replay. | Imports real messages without optional ACP response IDs; not compaction or successful native resume. |
| `F-before` | Cancel before submission | Caller-owned gate sends no prompt or Pi call; subsequent probe succeeds. | Runtime submission boundary, not full UI cancellation. |
| `F-active` | Cancel active prompt | Observed activity and still-active prompt, cancel RPC, stopped process/cleared broker, fresh-runtime successful probe. | Ended turn before boundary is inconclusive; timing is observed, not inferred from sleep. |

## Evidence, outcomes and cleanup

Capture boundaries, not model claims: pinned backend/runtime versions, configuration request/response, session identity, actual tool execution and persisted history, permissions, notifications, read requests/responses and cleanup. Image fixtures carry real visual markers absent from prompt/tool text; the harness preserves requested image bytes without Pi resizing. Image recovery must identify the current-session artifact under `GEMINI_HOME/antigravity-acp/brain/<session>/.system_generated/steps/` and observe a distinct tool-free image-observer session and its actual derived read response. Record original/artifact hashes; backend re-encoding alone is not failure. Observer image bytes must match the actual artifact, and the visual marker must survive.

Offload thresholds are backend-dependent. Only an actual Pi tool result offloaded by AGY counts: seeded reader fixtures, an invented reference, an original workspace file or replaying the tool do not. Text recovery must follow actual page continuation and recover the hidden tail from a read response; image recovery must preserve the fixture's visual marker through artifact and observer boundaries.

| Status | Meaning |
| --- | --- |
| `PASS` | Intended path reached and every assertion supported by direct evidence. |
| `FAIL` | Assertion/read recovery or cleanup failed, or setup/backend/transport/deadline error occurred. Identify the failing boundary/category. |
| `INCONCLUSIVE` | Execution occurred but model behavior, missed timing, absent chooser or no offload within bounds prevented reaching the target. Never hide a reached bad assertion/read recovery here. |
| `SKIP` | No eligible execution: missing opt-in/consent, environment or authentication prerequisite. Filtered scenarios are omitted. |

Private `results.json` and `summary.md` report status, reason, category, environment and per-scenario evidence filenames; scenario JSON contains sanitized RPC/read/permission/notification traces and test-owned history. Auth instrumentation retains only allowlisted facts, not authentication payloads; backend stderr is not evidence. Redaction is best effort: review before sharing, never print inherited environment or retain tokens, account identifiers or raw subprocess logs.

Always attempt cleanup after failure or timeout: stop owned runtimes and observers, close brokers/pending calls, remove scratch installation/session state and report cleanup failures separately. Preserve reports outside scratch; the externally prepared workspace remains operator-owned, including disposable backend state/artifacts. Destroy the container after review.

## Focused verification

Reconcile matrix IDs and tiers with `tests/live/scenarios.ts` and controls with the runner before each upgrade. `bun run test:live:acp` explicitly runs the separate live entry; `bun run test` discovers only `*.test.ts` and stays offline. Run the entry without live opt-in to check skipping without installation/auth/workspace mutation, then run selected live cases only in the attested environment.

Record check results separately from authenticated live reports. Record the exact commit and dependency versions with each check. Historical offline results do not establish a pass for the current branch. The local synthetic auth fixture validates harness auditing/cancellation only; it is not a live auth result.

No authenticated live compatibility pass is claimed in this document; list unreached subcases and limits even when deterministic fixtures pass.

## Current-version design assessment

The assessment target is Bridge `0.5.1`, managed AGY ACP `1.4.5`, ACP SDK `2.0.1` and Pi SDK `1.4.0`, based on main `ae5a96f`. Resolve the actual managed release at execution time. Backend observations from ACP `1.4.4` are diagnostic history, not compatibility evidence for this target.

The API-adapted harness passes typecheck and the complete offline suite: 2,130 PASS, 13 SKIP, zero failures. The no-opt-in live entry reports all 17 core scenarios SKIP. These checks do not establish authenticated backend compatibility.

The implemented matrix remains 17 core and 3 extended cases. Preparation observations must capture instructions, effective tools, session mode and reconstruction decisions. Submission observations must capture provider-prepared messages and actual ACP payloads. The provider owns history selection; the runtime only serializes prepared content. Low-level runtime cases do not establish real Pi provider behavior.

### Proposed additional evidence — not implemented

| Priority | Scope | Required evidence |
| --- | --- | --- |
| P1 | Usage without tools and across `A-success` / `A-error` | Capture final prompt-response usage, context updates, runtime accounting and persisted Pi usage entries. One completed native prompt with valid usage produces exactly one `agy_turn` entry, including after an MCP handoff; context occupancy is separate. Compare input/output/cache/thought fields with the production mapping, retaining raw allowlisted counters for backend-contract review. Do not require thought messages or nonzero cache counts. |
| P1 | Pending-result steering | Hold a real Pi tool execution, queue a correction through Pi's supported update path, then release the result. Observe the correction in the MCP result appendix, no extra native prompt for that continuation, and a final response or next action that follows the correction. Use a handler-only receipt and execution counts rather than a model claim. |
| P2 | Rebuild semantics | Extend `D-rebuild` with successful, failed and unconfirmed historical operations. Observe the prepared history and new ACP payload, no completed side-effect replay, correct status interpretation and no invented omitted result body. Keep exhaustive serializer combinations offline. |
| P2 | Standalone compaction isolation | Extend `G-compaction` with actual tool-free session RPC configuration, direct summary-task payload, and unchanged conversation checkpoints during the summary. Keep persisted summary, fresh-runtime continuity and no-replay assertions. |

Nonzero cache/thought accounting needs an observed backend sample. A run without those fields cannot establish that branch of the backend contract. Do not make every compatibility run force a cache hit or visible reasoning.

### Execution batches

- Start with `AUTH-probe`, `CONFIG-instructions`, `A-success` and `A-error`. Explicitly choose a backend-advertised model; `gemini-3.8-flash` is a candidate from prior diagnostics, not a confirmed ACP `1.4.5` selection. Supply an effort level supported by that model.
- Run image transport, real MCP image recovery and text offload next. Keep bounded sweeps and distinguish unreached offload from failed recovery.
- Run native-tool protection, Client Read scope, cancellation, lifecycle, rebuild and compaction after the first batch is stable. Run negative auth and interactive login only in separately prepared environments with their required consent.

### macOS execution — unresolved

The implemented runner supports isolated Linux only. A host-local mode needs separate consent and a distinct report label; setting the isolation flag does not create a sandbox. Any proposed local mode must use temporary Pi/project state, reject executable overrides, resolve the pinned managed release, and identify backend credential/cache/session writes that cannot be isolated while reusing login. Local login and negative-auth mutation must remain disabled by default. No local mode or authenticated execution is authorized by this assessment.
