# Stepsemble 3.0.48 — Claude desktop execution context

## Issue and change

On the Mac Mini, the HTTP host is deliberately launched through localhost SSH.
The existing desktop helper could report a successful Claude sign-in in Aqua,
while the newer native stream-json branch still spawned Claude directly from
the SSH host. Native execution therefore reported `Not logged in` despite the
desktop sign-in. Sharing HOME did not mean sharing the macOS login context.

Native Claude launches now use the same owner-only desktop helper as sign-in.
The helper owns the executable, environment and allowed project roots. A
one-use launch ticket opens a bounded local stream carrying the native protocol;
the HTTP caller cannot supply a shell command or override the desktop HOME.
Missing helpers, ambiguous launches and invalid frames fail closed, without a
second SSH launch or an automatic prompt replay.

Model discovery/switch acknowledgements, images, explicit permissions,
interrupts and reported context usage remain native operations. A reported
context percentage still requires actual native usage and capacity; sign-in
alone does not manufacture usage.

The already-installed immutable helper has an explicit `--upgrade` path and
authenticated `POST /api/claude/desktop/upgrade` repair operation. It requires
an idle, verified Aqua helper, preserves the existing private configuration,
and rolls back a failed runtime change. It does not install a missing helper,
log into Claude, copy provider tokens or alter the subscription account.

Frontend reconciliation is per turn, preserving repeated answers in different
turns while avoiding duplicate partial/assistant/final-result text.
The permission HTTP route now awaits the native write result instead of
serializing an unresolved promise as an empty success response. Unconfirmed
process cleanup remains update-blocking, including a disconnected opener.

## Validation

- Final local suite: 1,450 passed, 4 skipped, 0 failed (1,454 tests).
  Syntax, typed client, generated protocol, 1,251 independent conformance
  cases, version consistency and whitespace checks passed.
- Actual macOS launchd Aqua / synthetic Claude gate passed: sign-in metadata,
  legacy tasks and structured native controls use Aqua even when the caller
  supplies an SSH environment. Model acknowledgements, permissions, context,
  owned-child cleanup and legacy supervisor restart/reattach are covered.
  This gate makes zero provider inference or login calls.
- Local transport tests cover a 1.2 MiB image, fixed helper HOME/environment,
  ticket replay, roots, origin/auth refusal, frame boundaries, disconnect
  cleanup and immediate process-exit ordering.
- Isolated HTTP regression covers open, models, model switch, prompt, events,
  pending permissions, permission write result, context and confirmed close.
- Upgrade tests cover complete staged dependency loading, old/new helper
  compatibility, maintenance exclusion, delayed launchd removal, verified
  rollback readiness and preservation of configuration/private IPC key.
  Platform-specific filesystem fixtures are explicitly skipped on Windows.

## Explicit boundaries

- A genuinely signed-out host still needs its own official Claude sign-in.
  One Mac's login is not copied to the other Mac.
- Existing failed task output is preserved. The fix does not automatically
  resend its prompt or turn a failed historical process into a live process.
- Authentication metadata is not a paid inference check. Offline protocol
  fixtures are not represented as subscription model responses.
- Codex installation/version compatibility and unrelated connectors are not
  changed by this patch. No new long-running goal or 72-hour soak is started.
