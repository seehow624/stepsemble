# Stepsemble 3.0.77 — truthful external Codex status and IME-safe input

## What changed

Codex App and Stepsemble run separate Codex app-server processes. Native history
can be read by both, but live in-memory state is not shared: the second process
reports a Desktop-owned thread as `notLoaded`. Stepsemble now observes Codex's
own persisted turn database and the selected rollout in read-only mode. A task
that is still running in Codex App is shown as Working in Sessions and inside
the conversation, with the persisted turn start time rather than a timer that
restarts when the browser opens.

The context dashboard now uses the latest bounded `token_count` record for that
exact thread when the independent app-server has no live token snapshot. It
shows current context tokens, the model window, percentage, input/output,
reasoning and cache figures. The persisted source is labelled separately from
a live Stepsemble-owned native connection and never grants mutation authority.

Refreshing a large Codex session is more reliable. Known history responses now
use the transport's existing 8 MiB history budget instead of the ordinary
1 MiB frame limit; unrelated, unknown, model and initialization responses keep
the strict limit. If native metadata is briefly unavailable, authenticated
persisted state can open the conversation in monitoring mode while history
reconnects. The UI no longer calls an externally running read-only task ended.

The Web composer also tracks IME composition explicitly. Enter used to commit
Chinese input—including Safari's `compositionend`-before-`keydown` ordering and
legacy key code 229—is consumed without sending. The following Enter remains a
normal submit action on desktop.

## Security and performance boundary

Only UUID thread identifiers are accepted. Database filenames are fixed below
the current user's `.codex` directory and opened read-only with query-only and
untrusted-schema protections. The selected rollout must be an owner-controlled,
non-linked file inside Codex's `sessions` or `archived_sessions` roots and must
end in the requested UUID. Context reads inspect at most the final 8 MiB,
reject replacement, truncation or permission widening, and never expose a
rollout path to the browser.

Session-list polling reads only indexed latest-turn rows for at most 64 recent
Codex entries through one read-only database snapshot. The heavier bounded
rollout tail is read only when a conversation is opened. No credential, model
request, prompt, approval, task interruption or Codex-owned file write is
involved.

## Verification

All 1,524 automated tests pass (1,520 passed, four platform skips), along with
syntax, client/protocol generation, version consistency and the complete
rolling-browser suite. That browser gate covered old/new client-host pairs,
desktop/mobile PWA behavior, 301-session and 5,000-message workloads, native
Codex activity presentation, thinking, viewed images and Goal state without a
provider call.

A real isolated Stepsemble instance also opened the currently running Codex App
task after refresh, loaded a 5.38 MiB turn page without a transport failure,
showed Working in Sessions and the conversation, and updated the context gauge
from Codex's current persisted count instead of Unknown. No provider or model
call was made during verification.
