# Stepsemble 3.0.52 — Resolve the executable the user's shell would pick

## Issue and change

When a service is started by launchd it inherits a bare
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`, so command resolution falls back to a
built-in directory list. That list searched `/opt/homebrew/bin` before
`~/.local/bin`, which is the opposite of the order an interactive macOS shell
uses.

On the MacBook Pro this selected `/opt/homebrew/bin/codex` — a third-party
autostart shim wrapping Codex 0.146.0 — while the user's own shell resolved the
official 0.154.0 install at `~/.local/bin/codex`. The host reported an unproven
source and stayed on the old schema, and installing the official CLI did not
help because the fallback order still preferred the shim. The Mac Mini was
unaffected only because its service starts through SSH and inherits a full
`PATH`.

User-owned locations are now searched first, matching both the interactive
shell and the user's intent. The same order is applied to the harness update
service, which kept a separate copy of the list.

## Validation

- Full local suite: 1,455 passed, 4 skipped, 0 failed (1,459 tests).
- New regression resolves a connector with an empty `PATH` and asserts the
  executable under `~/.local/bin` is selected through the fallback list.
- Syntax, typed client and version consistency checks passed.

## Explicit boundaries

- This changes only the fallback used when `PATH` does not already resolve a
  command. An explicit `PATH` entry and the `*_BIN` environment overrides keep
  precedence.
- Provenance is unchanged. A resolved executable whose install source cannot be
  proven still fails closed and is never updated.
- Third-party shims are not removed or modified; they are simply no longer
  preferred over a user's own installation.
