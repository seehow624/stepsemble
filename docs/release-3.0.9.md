# Stepsemble 3.0.9 release record

This is a stable incremental release. It closes the generic Agent Hub journal
and capability-boundary gaps; it does not claim that every upstream harness has
the same native transcript, subagent store, approval protocol or resume API.

## Included

- Windows generic journal support is guarded by owner SID discovery and a
  non-interactive PowerShell owner-only DACL on both the journal directory and
  SQLite file. This protects future `-wal`/`-shm` siblings as well as the main
  file. POSIX owner/mode/canonical-path checks remain unchanged.
- Agent Hub catalog and task DTOs distinguish `native_full`,
  `native_readonly`, and `canonical_bounded` history. Claude/Codex read-only
  capability is advertised only for explicitly validated native source groups.
- Canonical journals remain Host-local. A paired device can use the existing
  authenticated `/r/<machineId>/api/agent-events` relay to read the origin
  Host's cursor history; the release does not introduce a cross-host database
  or replication protocol.
- Generic approval metadata now says `approval_ack_required`. A durable user
  decision is not treated as native acknowledgement or resume. The child must
  return a correlated `STEPSEMBLE_ACK`; otherwise the run stays
  `awaiting_confirmation`.

## Explicit limits

Pi keeps its native session/history path. Claude Code, Codex, OpenCode and Grok
Build can only expose capabilities their installed, reviewed adapters prove.
Where an upstream CLI does not emit the Stepsemble ACK or does not expose a
stable native history/subagent store, Stepsemble preserves a bounded canonical
view and fails closed. It does not scan private directories, alter provider
credentials/subscriptions, infer approval from a pipe write, or fabricate a
native transcript.

## Verification

The release gate passed on Node 22.22.3:

- Full Node suite: 1246 passed, 2 platform skips, 0 failed.
- `npm run check`, `check:protocol`, `check:client`, and `version:check` passed.
- Protocol conformance: 1251 cases passed.
- `git diff --check` passed.

The final commit and tag are recorded by GitHub after publication.
