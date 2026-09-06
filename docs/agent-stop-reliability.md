# Generic Agent stop / recovery follow-up

Status: implementation and isolated verification in progress, not yet released.

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
as part of these tests. Physical mobile sleep/resume, 72-hour soak, durable Pi
ownership, native approval/history parity and Rust/App migration remain open.
