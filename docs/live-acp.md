# Direct AGY ACP contract diagnostic

`bun run check:acp` is the entry point for a direct AGY ACP contract diagnostic.
It is not a Pi live suite or a Pi integration compatibility test.
The script sends ACP requests directly; verification status is recorded separately.

## Invocation and side effects

```sh
bun run check:acp
```

Normal invocation is live opt-in: it may download the pinned backend, send billable
prompts, and change host backend cache/session state. Prepare backend authentication
externally before running. Cancellation does not guarantee zero cost.

`bun run check:acp --help` is offline: no installation, backend launch, or prompts.
There is no environment matrix, consent-flag setup, scenario registry, or model selection.
The fixed configuration is `gemini-3.8-flash`, mode `default`, effort `low`.
`--cancel` optionally adds the activity-gated cancellation check.

## Transport and isolation boundary

`scripts/check-acp.ts` uses the production raw `Connection` transport and
`ensureInstallation` with a temporary `agentHome` and the pinned managed release.
It does not substitute a host executable or start Pi, a provider, history
reconstruction, compaction, or a mock MCP server. Sessions use `mcpServers: []`.

The diagnostic reuses the backend's existing host authentication environment.
It does not read or copy OAuth tokens, log in, log out, or delete credentials.
An unavailable authenticated backend is not an authenticated compatibility pass.

A temporary agent home isolates the managed installation, not the backend or OS.
Host backend cache, sessions, and artifacts may still be written outside scratch.
Sending `enabledTools: []` records disabled-native configuration; it does not prove
an attempted native operation was denied or establish an OS sandbox.

## Checks and evidence

- Inspect initialization for advertised `systemPrompt.append` support and send
  instructions through `_meta.antigravity.systemPrompt.append` on session creation.
- Record `_meta.antigravity.enabledTools: []` in the actual session request.
- Apply mode `default`, model `gemini-3.8-flash`, and `thinking_level: low`;
  verify actual configuration responses, not requested values alone.
- Use a text instruction marker to check instruction delivery, then a second
  prompt in the same session to check memory without repeating the hidden value.
- Send a tiny red image directly in an ACP prompt and check the visual answer.
  This checks direct image input, not Pi image injection or tool-result images.
- Capture raw final prompt usage and `usage_update` notifications separately.
  Inspect the observed fields without Pi accounting or usage conversion.
  Missing final usage remains `null`, not a zero or usage PASS; neither source
  is independent proof of billing totals.
- Attempt session load only when initialization advertises `loadSession`.
  Otherwise report `NOT_SUPPORTED`, not a load pass or a reconstruction result.
- With `--cancel`, observe prompt activity and confirm it is still pending before
  sending cancellation. A missed active boundary is not a cancellation pass.

The report retains the pinned backend version, allowlisted initialization facts,
requested/observed configuration values, prompt text responses, stop reasons,
raw numeric usage fields and context updates. It is not a full RPC trace and does
not retain auth payloads or backend stderr. A model answer alone cannot prove
configuration, usage or cancellation behavior.

## Excluded paths

MCP handoff, text/image offload, and Client Read recovery are not tested.
They require actual MCP-result prerequisites and observed offload/read boundaries;
pure prompts, seeded files, or invented artifact references cannot establish them.
Pi startup, provider integration, persisted history, compaction, and Pi usage
mapping are outside this diagnostic's scope.

## Reports, cleanup, and verification

Write a private JSON report to a temporary path and print its location for review.
Treat the report as sensitive; review it before sharing. Stop owned connections
and remove script-owned scratch on success or failure, retaining the report.
Installation teardown is joined before scratch removal. If the cleanup deadline
expires, report cleanup FAIL and possible retained scratch; do not claim removal.
Host backend state is not rolled back.

The prior live run established only an `AUTH-probe` pass. Six failing cases from
the Pi harness do not establish direct ACP incompatibility.
This replacement has not been run live and has no authenticated compatibility PASS.
Typecheck and offline help are checked separately from live execution. The existing
offline suite reports 2,057 PASS, 13 SKIP and zero failures; those checks do not
exercise this diagnostic against AGY or establish live compatibility.
