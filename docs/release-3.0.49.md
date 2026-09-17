# Stepsemble 3.0.49 — Unchecked harnesses no longer report as absent

## Issue and change

A harness that had never been checked was reported as `installed: false`.
That is a claim the service had not verified: the value came from an absent
observation, not from a resolved executable. On the MacBook Pro this marked
Claude Code, OpenCode and Pi as "not installed" while all three were running,
and the client disabled the upgrade control for exactly those rows, so the
first check could never be started from the interface.

`publicEntry` now reports `installed` and `executable` as `null` until a real
observation exists. The client treats `null` as unknown: the upgrade control
stays usable, and only a confirmed `false` disables it. The version line reads
"Not checked" instead of "Version unavailable" in that state.

Source-aware provenance is unchanged. Codex still refuses to update an
executable whose installed source cannot be proven.

## Validation

- Full local suite: 1,451 passed, 4 skipped, 0 failed (1,455 tests).
- New regression asserts `installed`/`executable` are `null` before a check and
  `true` after an actual observation.
- Syntax, typed client and version consistency checks passed.

## Explicit boundaries

- This corrects reporting only. It does not install, update or resolve any
  harness, and does not widen how provenance is proven.
- The MacBook Pro's Codex remains 0.146.0 with an unproven source; that is a
  separate item requiring local evidence of its install method.
- A Claude context percentage still requires a capacity that Claude itself
  reports. An attempt to fall back to the model list was written and then
  reverted: measured against Claude Code 2.1.270, the `initialize` response
  advertises `resolvedModel`, `description` and effort levels for all six
  models, and no context window at all. The fallback had no source to read and
  would have been dead code implying a fix that does not exist. A turn whose
  usage payload omits the capacity therefore reports real token counts with an
  unknown percentage, which remains the truthful result.
