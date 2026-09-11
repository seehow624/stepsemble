# Stepsemble 3.0.12 release record

## Scope

This release adds the first production-gated native adapter for OpenCode's
official local server and records the current upstream capability boundary for
Pi Agent, OpenCode, Claude Code, Codex, and Grok Build. It does not copy
provider credentials, private transcripts, or another machine's journal.

## OpenCode native contract

- The adapter is opt-in through `STEPSEMBLE_OPENCODE_SERVER_URL` (or the
  equivalent `OPENCODE_SERVER_URL`). Loopback is the default; remote access
  requires an explicit opt-in and HTTPS.
- Health, session, and permission probes are bounded and single-flight. A
  healthy server exposes native session list/get, status, child sessions,
  messages, async prompt, abort, and permission response operations.
- The New Project directory is validated by Stepsemble and passed as the
  upstream `directory` query/body scope. No port scan, `~/.opencode` scan, or
  credential migration is performed.
- Restart reconcile persists only bounded owner-only IDs/cursors/status facts;
  it never treats a local checkpoint as an upstream transcript or approval
  authority. Probe failure falls back to the canonical bounded connector.

## Other harnesses

The official interfaces are documented in
[`docs/agent-capability-matrix.md`](agent-capability-matrix.md). Pi remains
`native_full`; Claude Code and Codex expose enough structured session/approval
surfaces for future adapters but stay gated by their source and evidence
contracts; Grok Build exposes headless sessions, permissions, and ACP but its
Stepsemble adapter is not yet admitted. None of those boundaries are hidden
behind a generic terminal capture.

## Verification

The release gate includes:

- full `npm test` with zero failures;
- `npm run check`, protocol conformance, and client build checks;
- dedicated OpenCode adapter fixtures covering malformed input, old-server
  permission degradation, directory scoping, approval decisions, bounded
  reconcile, and restart detection;
- a live route probe against the installed OpenCode 1.18.5 server proving
  native discovery and `/api/agent/open` directory propagation;
- all required GitHub Actions checks for the `v3.0.12` tag.
