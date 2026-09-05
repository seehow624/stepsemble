# Reliability follow-up — 2026-09-05

Unreleased development changes after `2f33f17`, not a deployment or completion
of the cross-platform roadmap. Production 3.0.3, native credentials, provider
profiles and brand assets are untouched. Tests use temporary homes and synthetic
agents only.

## Implemented and regression-tested

| Failure | Change | Evidence |
| --- | --- | --- |
| Trash rename failure permanently unlinked the session | `/api/delete` now archives and returns `archiveId` / `recoverable`; UI says Archive and offers Undo | HTTP archive/restore byte equality; failed destination preserves source |
| Open process can append to a moved session | Reject archive of an open Pi session, including idle processes; project archive preflights before any moves | Production-function ownership test; 409 until the process exits |
| Restore/archive could traverse a symlink | Reject symlinked descendants; restore never overwrites an existing destination | Redirected archive test; original and outside folder unchanged |
| Corrupt parent chain blocks Node forever | Visited-ID cycle detection, 422 with original preserved | Self-cycle/multi-cycle unit tests; HTTP health remains responsive |
| One unterminated history/RPC frame grows without limit | Byte-framed 16 MiB record bound; IPC 8 MiB; file reader accepts final newline-less records | UTF-8 split at every byte; oversized/truncated frame and oversized history tests |
| Chinese/emoji split across stdout chunks becomes replacement characters | Decode after newline framing; native stream decoders for terminal stdout/stderr | Boundary/CRLF tests |
| SSE falsely drops a live subscriber on `write(false)` | Use Node's ordered queue, maximum 8 MiB, disconnect after 30-second stall; do not drop accepted frames | Slow Writable order/flush, overflow and stall tests |
| Supervisor snapshot followed by replay repeats output | Advance snapshot cursor atomically; explicit replace snapshots in UI | Control reconnect and service restart assert one copy of output |
| Slow worktree creation blocks every request | Async execFile, two-operation admission bound, timeout and HTTP-close cancellation | Event-loop timer/abort, capacity-release, partial-tree preservation tests |
| History/translation does redundant main-thread work | Offline staging with yielding; linear adjacent-message merge; translate only added roots and deduplicate ancestors | Merge barriers and scoped-localization tests; browser follow-up below |
| Copy/Retry contrast and model accessible name fail | Remove action-row opacity reduction; model name uses visible label | Lighthouse chat accessibility 100 in measured state |

## Browser follow-up

Same fixture as [original baseline](browser-performance-baseline.md): 301 sessions,
41,000 messages, longest history 5,000, latest 300 rendered, synthetic 600-delta
stream. Chrome desktop 1440×900/DPR1/CPU1; mobile 390×844/DPR3/CPU4; no network
throttling. [Returned tool evidence](baselines/reliability-browser-2026-09-05.json)
is saved separately from the original immutable baseline.

- Final scoped-localization desktop open trace observed INP **172 ms**, versus
  the prior 537 ms. It still contained long tasks; this is not proof that all
  asynchronous work fits a frame.
- Final mobile restore's buffered browser LCP entries ended at **2,972 ms** with
  all 300 messages present; trace CLS rounded to **0.00**. The MCP trace reported
  `NO_NAVIGATION` and omitted LCP, so this number comes from the browser's
  PerformanceObserver, not an invented trace metric.
- Final 600-delta stream delivered all chunks and returned to idle. Its observer
  recorded one **120 ms** long task in the stream/completion window, versus the
  original 479 ms completion task. Residual work still exceeds a frame budget.
- Intermediate experiments are not final results: mounted incremental history
  caused repeated 160–283 ms layouts; offline staging alone still observed
  5,484 ms mobile LCP. The whole-document translation fallback was then removed.
- Only synthetic-origin service worker registrations/caches were cleared when
  source verification showed a stale script. No production-origin cache changed.
- These are single-run lab observations, not field percentiles. Raw trace export,
  standardized TBT, repeated cache-controlled trials, physical devices and
  long-duration/multi-client measurements remain open.

## Still open — do not mark the whole plan complete

Local verification: 148 tests, 147 passed and one Windows-only skip; JavaScript
syntax, strict TypeScript/generated artifact and version consistency checks
passed. Cross-platform CI is verified separately after pushing; local success is
not a substitute for that matrix.

1. Protocol v1 complete domain schemas/validators, native RPC golden transcripts,
   client handshake usage and rolling compatibility matrix.
2. Durable event journal and generation-aware cursor recovery. Generic tasks
   still retain only a 64 KiB tail; replacement is not full history. Input ACKs
   still lack durable idempotency and supervisor-confirmed delivery.
3. Full native Claude/Codex/etc. session/history/approval/resume adapters, version
   compatibility tests and explicit subscription/API/router billing boundaries.
4. Pi process survival across Host restarts; durable, multi-client-safe approvals.
5. Archive management after the Undo toast expires, backup/restore drills and
   crash/power-loss tests. Archiving currently refuses open Pi sessions; it
   cannot coordinate writes from independently launched native clients. Local
   filesystem symlink race hardening is not a hostile-local-user sandbox.
6. Frontend virtualization, residual long tasks, repeatable performance gates,
   physical mobile background/resume and network/soak tests.
7. Remaining installer real-runner checks, Rust Host migration, Apple Tauri PoC,
   native clients and store distribution, per the accepted phase gates.

Next entry point: [Plan 1.7](platform-plan.md), then Protocol v1's remaining
contracts. Do not change the decided language/platform boundaries or relabel
terminal integrations as native parity.
