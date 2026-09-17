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

## Context percentage without a reported capacity

Claude reports per-turn usage, but not every payload carries a context window.
A real token count was then shown without a percentage. The `initialize`
response already advertises each model's context window, so that value is now
used when the usage payload omits one.

The capacity is matched to the exact model id. Another model's window is never
substituted, and a model absent from the advertised list still yields an
unknown percentage rather than an invented one.

## Validation

- Full local suite: 1,452 passed, 4 skipped, 0 failed (1,456 tests).
- New regression asserts `installed`/`executable` are `null` before a check and
  `true` after an actual observation.
- New regression asserts a Sonnet turn uses Sonnet's advertised 200k window and
  never borrows the larger Opus window present in the same model list.
- Syntax, typed client and version consistency checks passed.

## Explicit boundaries

- This corrects reporting only. It does not install, update or resolve any
  harness, and does not widen how provenance is proven.
- The MacBook Pro's Codex remains 0.146.0 with an unproven source; that is a
  separate item requiring local evidence of its install method.
