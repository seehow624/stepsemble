# Stepsemble 3.0.30 release candidate

This note describes the release candidate. It is ready for the normal release
checklist once the cross-platform CI matrix and signed updater artifact are
verified.

- Added Google Antigravity (`agy`) to the allow-listed Agent Hub connector
  catalog with a local source identity and offline-cached mark.
- Added the opt-in `antigravity-cli-stream-json-v1` bridge using the documented
  `--input-format stream-json` / `--output-format stream-json` contract,
  conversation-ID locking, bounded event replay, prompts, close, and explicit
  fail-closed approval handling.
- Added allow-listed Cline, Kilo Code, and Hermes catalog entries with explicit
  category/maturity metadata, local source marks, and conservative bounded
  fallbacks. Their private credential/session stores are never scanned.
- Preserved user-supplied task names for structured Claude Code and Antigravity
  sessions, and for Grok ACP rows, instead of replacing them with generated IDs.
- Reconciled Claude structured task status, native session ID, timestamps, and
  terminal state into the Agent Hub on every poll; confirmed native child cleanup
  before removing a Claude task from the in-memory registry.
- Added a Codex executable-version preflight; an unreviewed alpha fails closed
  before app-server I/O and remains available through the bounded CLI connector.
- Limited the home Agent Hub preview to a bounded connector/task window while
  keeping the task center as the complete searchable view.
- Added parser/session fixtures, catalog and identity regression coverage, and
  included the new bridge in `check:session`.

The structured bridges are opt-in (`STEPSEMBLE_CLAUDE_STRUCTURED=1`,
`STEPSEMBLE_CODEX_NATIVE=1`, and `STEPSEMBLE_ANTIGRAVITY_STRUCTURED=1`) and do
not inspect or migrate vendor credentials or private session stores. Claude's
public stream still cannot safely fabricate an approval ACK; Codex mutation
remains a separately gated app-server capability.

Final local validation: 1,291 Node tests passed, 3 skipped, 0 failed; protocol
conformance, a short two-task restart/reconnect soak, syntax/session checks,
client artifact checks, version synchronization, and `git diff --check` passed.
