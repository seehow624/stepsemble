# Stepsemble 3.0.50 — Check Claude Code and Codex updates in the app

## Issue and change

Neither harness could report whether an update existed.

Claude Code was configured to check with `claude update --check`. That flag no
longer exists: Claude Code 2.1.270 answers `error: unknown option '--check'`,
and its `update` command checks and installs in one step. The service
correctly refused to present that as a result and reported "unknown", so the
row never showed an available update.

Codex resolved its source as `official-standalone`, which also has no dry-run
probe, and the service deliberately returned "unknown" rather than running
`codex update` just to discover whether an update existed.

Both now read the version published to the official npm package and compare it
with the version the installed executable reports. `npm view <package> version`
queries the registry without modifying the installation.

Reading the registry is not a provenance claim. Codex still updates only
through its proven install source, and an executable whose source cannot be
proven still fails closed and is never updated. A lookup that fails reports
"unknown" instead of implying the harness is current.

## Validation

- Full local suite: 1,453 passed, 4 skipped, 0 failed (1,457 tests).
- Measured against the real installations on the Mac Mini: Claude Code reports
  2.1.270 installed with 2.1.274 published, so the row shows an available
  update; Codex reports 0.154.0 installed and published, so it shows as up to
  date with its source still resolved as `official-standalone`.
- New regressions assert that the check runs only `--version` and the registry
  read, never the updater, and that a failed lookup stays "unknown" rather than
  claiming the harness is up to date.

## Explicit boundaries

- This adds a non-mutating check. It does not change how either harness is
  updated, and does not widen how an install source is proven.
- The MacBook Pro's Codex still has an unproven source, so it remains excluded
  from updates until its install method is established locally.
