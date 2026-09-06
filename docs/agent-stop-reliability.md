# Generic Agent stop / recovery follow-up

Status: 3.0.6 candidate implemented; final-source release gates pending.

## Evidence and scope

Stable 3.0.5 source `7851c10` passed three-OS CI 34022367919 and rolling browser
34022367901. Later docs-only `fbc0d42` failed Windows CI 34022716198:
`generic connector tasks stream bounded output and stop without shell injection`,
the `service.stop()` assertion after destroying the control socket and waiting
800 ms. The old code cannot distinguish a missing task from a temporarily
unavailable control connection. Its fallback returns false but marks the task
stopped and signals a persisted supervisor PID. On Windows that signal can
terminate the supervisor before owned-tree cleanup. The runner log does not
prove that every observed failure took this fallback, so retain both the race
and confirmed code defect rather than labelling it a harmless test flake.

## Implementation / acceptance order

1. Share pending attachment readiness, verify identity before commands/events,
   and fence delayed close events from an older socket.
2. Await confirmed CLI exit for stop/close, coalesce concurrent requests, keep
   update/auth launch gates active until exit; never infer success from a write
   or kill a persisted PID when IPC is unavailable. A bounded uncertain stop
   returns 409 and remains retryable; missing tasks remain 404.
3. Test stop during a real disconnect, repeated stop, no-ack timeout and retry,
   surviving web-service restart, output deduplication and actual owned process
   exit. Run exact-source Windows/macOS/Linux CI; do not only increase sleeps.
4. Extend isolated archive/restore/restart tests with byte equality and
   conflict preservation. This is not proof of whole-Host backup restore.
5. Re-measure synthetic long history with Chrome DevTools recording and Codex
   Computer Use interaction. Preserve actual evidence and missing metrics;
   optimize only a measured or directly reproduced bottleneck.
6. Before release, verify version/client/protocol artifacts, three-OS CI and
   rolling browsers. Use existing verified update/rollback workflow only with
   idle Hosts; never stop real work to deploy.

No native model calls, credential changes, logo edits or Host restarts occur
on production as part of these tests. Physical mobile sleep/resume, 72-hour soak, durable Pi
ownership, native approval/history parity and Rust/App migration remain open.

## Results (2026-09-06)

- First stop fix `ae0cebc` passed CI 34027450549 on Windows/macOS/Linux and
  rolling browser 34027450520 on macOS/Linux. Local 333 tests: 331 pass, two
  platform skips. Final candidate adds selection/stop-feedback regressions.
- Real synthetic supervisor disconnect/stop and Web service recreation pass;
  the original output occurs once. Canary/no-ACK test proves a timed-out stop
  leaves the named process alive and task active, then an explicit retry works.
- Archive HTTP test now stops and restarts an isolated Host before recovery,
  verifies conflict bytes are unchanged, moves only the fixture's conflicting
  file aside, restores original bytes and keeps an unknown recovery sidecar.
  Fixed recursive archive cleanup, which previously erased that sidecar;
  cleanup now removes empty directories only. This is not a full-machine or
  power-loss restore rehearsal.
- Opening a session no longer rebuilds all visible list rows. Selection uses
  an exact dataset identity and `aria-current`, preserving DOM/focus/scroll.
  Unit regression plus desktop/mobile CI row-identity assertions cover it.
- Actual Chrome/Codex Computer Use desktop fixture: 301 sessions, 41,000 messages,
  latest 300 of the 5,000-message session, 1200×773/DPR1/CPU1×. First open before
  selection change observed INP195 ms; final warm reopen observed INP72 ms.
  Intermediate Back+Open trace observed119 ms. These are different warm/cold
  interaction contexts, not a controlled percentage improvement or p95 result.
  CLS0 in these windows; all14 shell/script/style requests200; no console
  warnings/errors. Desktop long-chat Lighthouse snapshot accessibility100 and
  best-practices100, automatic state-specific checks only.
- Returned evidence is preserved in
  [`baselines/session-selection-2026-09-06.json`](baselines/session-selection-2026-09-06.json).
  Both `/tmp` and repository trace export paths were rejected by the MCP's
  configured roots; full raw traces and standardized TBT remain unavailable.
  No viewport/CPU emulation or whole-browser preference was changed.
