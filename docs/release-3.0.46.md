# Stepsemble 3.0.46 native stability follow-up

## Scope

- Independent bounded Codex native children (default four), dedicated history
  transport, scoped journals, resume deduplication, idle-only eviction, and
  conservative cleanup/quarantine. A failure reading history cannot hide a
  live child from update safety checks.
- Native Codex approval cards show the exact request details, with 44px
  minimum actions. Missing/oversized details disable Allow. Request identity
  preserves numeric/string IDs and thread scope. Written is not acknowledged;
  uncertain delivery is never automatically resent.
- Foreground/network reconciliation is read-only and single-flight for native
  conversations. Idle Codex chats remain observable; hidden pages skip polls.
- Settings can enable an owned OpenCode server on an ephemeral loopback port.
  Both unauthenticated rejection and authenticated health are required. The
  generated credential remains in memory; only user opt-in is persisted.
  Existing explicit server configuration is reused, never replaced.
- Codex updates retain a proven installation source. Unknown shims fail closed;
  a successful updater exit without a valid post-update version is not success.
  Live turns, pending approvals, in-flight requests and setup block updates.
- OpenCode retry states and active sessions outside the first history page
  remain visible to task/update guards.

## Validation

Local full suite: 1,394 passed, 4 skipped, 0 failed. Syntax, generated client
and protocol checks passed; independent schema conformance passed 1,251 cases.
Release CI and actual host rollout results are recorded in the deployment
handoff. Real official Codex 0.154.0 was exercised with isolated HOME/config,
synthetic history, a loopback Responses fixture, and no paid model calls:

- Composer: native model discovery/switch, a 1,200,090-byte PNG input,
  context readback, exact-thread interrupt, confirmed owned-child cleanup.
- Parallel: two simultaneous threads, interrupt A without affecting B,
  distinct context accounting, exactly two local model requests, cleanup.
- Real OpenCode 1.18.30: isolated HOME, unauthenticated health rejection,
  authenticated healthy response, idempotent start and confirmed cleanup.
- Mobile-width browser fixture: permission details and one-shot decision UI.

## Explicit boundaries

- Official Claude sign-in still belongs to the user. Signed-out hosts are not
  described as verified native inference, and credentials are not copied.
- A desktop browser viewport is not a physical iPhone acceptance test.
  Native photo picker and background/foreground behavior still need that device.
- ACP/structured recovery depends on upstream replay/resume. Persisted session
  identity is not a guarantee of complete replayed transcript or approval state.
  Antigravity's native approval UI remains a boundary; no fabricated approvals.
- Upstream version changes remain compatibility-gated. The new CI pins reviewed
  0.154.0 and does not claim every future alpha/stable release is pre-verified.
- No new 72-hour soak or perpetual goal was started for this patch.
