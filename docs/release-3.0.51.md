# Stepsemble 3.0.51 — Show which executable an unproven source selected

## Issue and change

When a harness resolves to an executable whose install source cannot be
proven, Stepsemble refuses to update it. That refusal is correct, but the
status reported only `source: "unknown"`. The operator was told an update was
refused without being told which file was selected, so there was nothing to
investigate. On the MacBook Pro this left Codex 0.146.0 stuck: unproven,
un-updatable, and with no local evidence to act on.

The service already resolved and stored that path. It is now included in the
status as `executablePath`, and the client shows it on rows whose source is
unknown. The value is a local path already selected from this host's own
`PATH`; it is not a credential or a remote reference.

Provenance is unchanged. Showing the selected path does not make a source
proven, and an unproven source still fails closed.

## Validation

- Full local suite: 1,454 passed, 4 skipped, 0 failed (1,458 tests).
- New regression asserts the path is absent before any check, matches the
  resolved executable afterwards, and is never invented for a harness with no
  resolvable command.
- Syntax, typed client and version consistency checks passed.

## Explicit boundaries

- This reports an already-resolved local path. It does not change how a source
  is proven, and does not update anything.
- The MacBook Pro's Codex remains unproven and excluded from updates until its
  install method is established.
