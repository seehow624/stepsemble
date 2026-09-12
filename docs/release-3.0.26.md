# Stepsemble 3.0.26 release record

## Scope

Expose the cursors already returned by the bounded Codex app-server history
adapter in the conversation view. When older turns or items are available, the
user can load another bounded page without leaving the task. Turns and items
keep independent cursors, overlapping pages are merged by native IDs, and the
loaded older pages survive live status polling. Loading older content preserves
the scroll anchor instead of jumping to the bottom.

Only `thread/items/list` defines transcript content and order; turn summaries
are metadata, not a substitute for full item pages. A burst that moves the
latest page beyond loaded history reopens the item cursor, shows a translated
gap notice, and inserts missing pages before retained older messages. Polling
reuses unchanged nodes. Reads are single-flight, abortable, and guarded against
host/conversation switches before each follow-on request.

The surface remains explicitly read-only: it does not send a turn, resume,
abort, or answer an approval request. If a bounded page fails, its cursor is
retained so a later click retries the same page rather than silently presenting
an incomplete transcript.

## Verification

- Codex transport fixture verifies cursor forwarding for both
  `thread/turns/list` and `thread/items/list`;
- eight executable frontend controller regressions cover independent cursors,
  end-of-history, retries, cyclic cursors, stable rendering, scroll anchors,
  burst gap recovery, single-flight reads and stale/aborted requests;
- full Node suite on macOS: 1,277 passed, 3 skipped, 0 failed;
- `npm run check`, `npm run check:client`, `npm run version:check`, and
  `git diff --check`.
- `npm run check:protocol`, `npm run check:protocol:conformance` (1,251 cases),
  and macOS shell syntax validation.
- Codex Computer Use in a loopback-only synthetic preview using the actual
  controller, message-shell function and CSS (390px panel): 50 → 100 → 120
  messages, stable visible message position on prepend, translated paging
  control, and no paging control after EOF. This is a Chromium fixture check,
  not a claim of iOS Safari or live-account verification.
- Correct the native interrupt fixture's pending-only expectation when the
  reply and terminal notification arrive together. Both return paths must match
  the requested turn, and terminal interruption, no command execution, and no
  approval acknowledgement remain mandatory. The prior Linux failure is retained
  locally in `/tmp/stepsemble-3.0.25-codex-ci-failed.log`; it is not hidden by a retry.
- Execute the three shell-embedded active-task predicates with owned fixtures;
  the Windows-only regression executes the actual PowerShell predicate in CI.
  Only a native Codex/OpenCode history row explicitly marked `isRunning: false`
  and `status: waiting` is exempt. Genuine waiting work, unknown idle evidence,
  mixed active tasks and contradictory running status must still defer updates.

Publishing the release makes it available to the existing stable updater; it
does not by itself prove that either Mac has installed it. Device rollout must
be verified separately, without interrupting active tasks.
