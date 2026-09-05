# Reliability follow-up — 2026-09-05

Unreleased development changes after `2f33f17`, not a deployment or completion
of the cross-platform roadmap. Production 3.0.3, native credentials, provider
profiles and brand assets are untouched. Tests use temporary homes and synthetic
agents only, except the explicit isolated/offline native Pi probe described below.

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

`26c4fbb` initially failed one Windows test because the test's source extraction
assumed LF. `29ec18e` normalizes CRLF; [CI 33949171058](https://github.com/seehow624/stepsemble/actions/runs/33949171058)
passed macOS, Windows and Linux. Later Protocol progress is tracked in Plan 1.8
and `protocol/v1/README.md`, not retroactively claimed as part of this hotfix.

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

Next entry point: [current plan](platform-plan.md), then Protocol v1's remaining
contracts. Do not change the decided language/platform boundaries or relabel
terminal integrations as native parity.

## Full history projection follow-up — Plan 1.15 (unreleased)

The [projection contract](../protocol/v1/projection.md) adds strict TS full bounded
message/tool/usage/context history using the existing entity reducers. All 35
events have explicit coverage; invalid late events roll back the entire proposal.
SHA-256 duplicate integrity, explicit identity-window floor, complete checksum
snapshots and a local revision-fenced replica handle concurrent/stale responses,
including same-cursor repairs. Partial terminal output remains explicitly
incomplete, not fake success. No native command is dispatched by projection.

Local verification: 227 tests, 225 passed, 2 Windows-only skips; independent Ajv
conformance 1,251 cases. Tests include all replay split points, 10,000 messages,
5,500-event identity rollover, corruption and async races. These are not browser
performance or DB/crash evidence. Real transactional receipt/entity/outbox, durable
store, authenticated snapshot transport, worker/paging and live rollout remain
open; the production service, accounts and brand assets are unchanged.

## Multi-row transaction follow-up — Plan 1.16 (unreleased)

The [transaction planners](../protocol/v1/transactions.md) now compose start and
approval admission, writer/winner/profile lock, receipt/private outbox and journal
projection into one detached proposal with a full store revision/cursor fence.
Dispatch markers bind one attempt/incarnation; pipe acceptance is not success.
Correlated approval ACK settles receipt and approval together without resuming a
run. Recovery preserves orphaned writers/uncertain effects and quarantines backups.

Local suite: 240 tests, 238 passed, 2 Windows-only skips. Thirteen new tests cover
two-device races, bad late events, mismatched outbox/proof and async input mutation.
The prior `646793d` projection batch passed all three OSes in CI 33964682613.
This is not DB or power-loss evidence; remaining command/effect builders, proof
storage, native adapters, actual durable transactions and rollout are still open.

## Start/failure cleanup — Plan 1.17 (unreleased)

Six more transaction tests cover normal/late startup acknowledgement, definitely
unsent writer cleanup, retained failed-key replay, verified non-application versus
unknown delivery, backup/dispatch barriers and stale/malformed cleanup rollback.
Unknown delivery retains the writer; a late startup ACK without recorded startup
must reconcile instead of resurrecting a stopping/orphaned/terminal run. These
are detached Host proposals, not live native calls, persistent storage or rollout.

Local full suite: 246 tests, 244 passed, 2 Windows-only skips; strict TypeScript,
generated artifacts and version consistency passed. `d7ac60a`'s 240-test batch is
verified green on macOS, Windows and Linux in CI 33965309286.

## Eight commands and terminal composition — Plan 1.18 (unreleased)

All eight command admissions now have transaction/effect planners. Exclusive
model/archive/restore/compact receipts retain their reservation through uncertain
delivery, so a new run cannot race them. Exact profile/archive/context ownership
is frozen; metadata changes only after correlated verified effect. Interrupt ACK
is not terminal completion. Terminal composition cancels/expires pending
approvals, preserves partial history and updates related receipt ambiguity
together, including quarantine rules for old backups.

Eleven new tests; full local suite 257 tests, 255 passed, 2 Windows-only skips.
The prior 246-test `5de5c81` batch passed all three OSes in CI33965895866. These
are still reference proposals; actual proof/storage/native integration, rolling
compatibility and live rollout remain open, without production/account changes.

## Native Pi follow-up — Plan 1.10 (unreleased)

The [native contract](../protocol/native/pi/README.md) now includes a real offline
Pi 0.84.2 transcript: 57 sanitized frames, native dialogs/timeout and persisted
session resume, without model calls or account credentials. This updates the
native-fixture item above only partially; durable/rolling gates are still open.

- Host-generated command IDs cannot be overridden by callers; response promises
  belong to the originating RPC session and command type. Malformed native JSON
  fails that owned child/pending commands without crashing the HTTP Host.
- Native UI replies are strictly typed; `confirmed:"false"` is rejected, never
  cast to approval. Only a matching pending method/option can be answered once
  in this Host process; generic RPC cannot bypass the dedicated reply endpoint.
- Pending dialog state is bounded, independent of the SSE event ring/cursor,
  restored on reconnect and excluded from idle cleanup/stuck-update heuristics.
  Answered/expired dialogs stop replaying, and other live clients receive close
  events. Browser duplicates do not wipe drafts; old-host replies are not sent
  to a newly selected device. Signal-exited children are not killed again by the
  delayed termination callback.
- Local suite: **170 tests, 169 pass, 1 Windows-only skip**; strict TS, generated
  artifacts, syntax/version checks, 802 Ajv cases and repeat native probe pass.
  Chrome isolated replay verifies dialog/cursor/false/close/draft handling; this
  is functional smoke, not another performance measurement.

`sent:true` is pipe-queue acceptance, not a native or durable ACK. Pending state
does not survive Host restart; upstream cancellation is not fully observable.
The single Web sheet still needs a multiple-dialog queue and reply-failure
recovery. Windows native Pi launch/arguments/version/model probing remains to be
fixed and exercised independently of the generic-agent Windows launcher. Real
model/tool streaming, native version/OS coverage and all original durable gates
remain open. Production **3.0.3 has not been restarted or deployed**.

## Queued native UI and Windows Pi launch — Plan 1.11 (unreleased)

- The single visible sheet now has a bounded strict-TypeScript FIFO behind it.
  Failed/unconfirmed sends retain input for manual retry, and each request has
  one in-flight send with a 12-second deadline. Late replies/old clicks cannot
  act on the next request. Provider UI suspends native drafts without storing
  provider secrets in the queue. Host/session switches clear local state.
- Leaving chat no longer closes an RPC with pending native input, including
  requests from older clients using `/api/close`. This is process-lifetime
  protection; page reload does not preserve typed drafts.
- Pi's version/model/RPC launch paths now share Windows-safe PATH/argv handling
  and owned-tree termination. Actual Windows batch/direct-script IO tests and
  the previously skipped native HTTP replay test are in the CI matrix. Batch
  expansion characters fail explicitly; an owner-configured CLI `.js` path
  permits literal arguments without silently bypassing a wrapper.
- Local suite: **181 tests, 179 pass, 2 Windows-only skips**, with strict TS,
  artifacts, syntax/version and 802-case Ajv conformance passing. Chrome mobile
  emulation verified real offline/online behavior, preserved input, no automatic
  retry, FIFO and manual button replies. OS-specific success must be checked in
  CI; this does not establish native Pi model/provider/tool parity.

See the [native contract](../protocol/native/pi/README.md) for exact constraints.
Full pending-set reconciliation after replay expiry, durable/idempotent state,
rolling compatibility, provider-auth recovery and Windows native package/resource
discovery still remain open. Production and native accounts remain untouched.

## Full native pending-set recovery — Plan 1.12 (unreleased)

- Opt-in SSE `connected` carries the complete versioned pending set, including
  empty state, without advancing the event cursor. Historical interactive/close
  replay is suppressed for opt-in peers; live events and older clients retain
  their existing paths.
- Strict TypeScript staging rejects malformed/oversized/duplicate snapshots
  before any mutation. Retained drafts and in-flight identity survive; missing
  or changed requests are removed without touching provider secrets.
- Old stream callbacks cannot mutate a replacement connection/view/Host. After
  a negotiated stream failure, native replies wait for a valid snapshot rather
  than just a transport-open event; there is no automatic side-effect retry.
- Tests cover actual 8,000-event ring eviction, cursor-neutral snapshots, ID
  reuse, empty recovery, legacy fallback, stale callbacks and late HTTP results.
  Local suite: **187 tests, 185 pass, 2 Windows-only skips**; strict TS/artifacts,
  syntax/version and 802-case Ajv conformance pass. OS results are verified in CI.
- Two-page Chrome mobile-emulation fault injection recovered one pending input
  with its draft, then an empty set cleared the stale sheet. Only expected
  Offline network errors were observed; see the checked-in browser evidence.

This closes the pending-set item from Plan 1.11 only. Full journal/projection
recovery, stateful/idempotency contracts, provider-auth durability, native parity,
rolling shipped-client compatibility and the later Rust/App gates remain open.

## Reserved command receipts and idempotency — Plan 1.13 (unreleased)

- Closed receipt schema and shared Node/browser/strict TS semantic parsing reject
  invalid revision, attempt, timestamp and outcome/evidence combinations. Stored
  metadata contains no prompts, native credentials or local paths; digests are
  still private data, not an anonymization guarantee.
- Pure Host reference helpers freeze eight UTF-8 command fingerprints and propose
  admission, replay, state transitions and recovery. Fresh authorization and two
  explicit consistent index reads are required even for a replay; changed intent
  under the same key fails rather than being silently delivered again.
- Six receipt states by five actions are covered exhaustively. CAS proposals,
  attempt matching, immutable terminal results and uncertain-state quarantine
  prevent the reference dispatcher contract from treating pipe acceptance as
  success or uncertainty as permission to retry.
- Restored backups may predate an already-executed dispatch marker. All receipts
  from restored/unknown origins require reconciliation, including `accepted`;
  only a verified current crash-consistent store follows ordinary recovery rules.
- Local suite: **199 tests, 197 pass, 2 Windows-only skips**; strict TS, generated
  artifacts, syntax/version and **853-case** independent Ajv conformance pass.
  The new 12 tests include simulated restart and competing proposals. They are
  not a database concurrency or durability test; OS results require CI evidence.

See the [command-state contract](../protocol/v1/command-state.md) for exact hash,
admission and transition semantics and the future transactional-store gates.
No live endpoint/capability, native dispatch, account change or production
restart is introduced. Full entity reducers, atomic approval winners, verified
native evidence, durable receipt/event/outbox storage, projection snapshot and
rolling compatibility remain open. A pure proposal never authorizes an effect.

## Entity lifecycle reference reducers — Plan 1.14 (unreleased)

- Strict TypeScript session/run/approval reducers and canonical revisioned rows
  now have one generated Node/browser artifact, with LF identity gated in CI.
  They are not loaded by the legacy UI or Host routes.
- The reserved union grows to 35 events: explicit archive restore, stopping,
  orphan/reconciliation, resume and native approval acknowledgement. Approval
  resolution binds the original receipt; it cannot claim a native ACK by itself.
- Terminal runs cannot revive; orphaned execution retains the writer fence;
  reconciliation preserves stop intent. Pending approvals need explicit terminal
  facts before run completion. Known source/auth changes require a fork, while
  per-run profile snapshots remain immutable.
- Related state/index reads, scoped IDs/nonces/native-request uniqueness,
  revisions and millisecond journal time fail closed. Decoded rows/events are
  bounded to 64 KiB, 64 levels and 8,192 nodes; new approval admission stops at
  32 unsettled records. Transport must still cap bytes before parsing.
- Local suite: **213 tests, 211 pass, 2 Windows-only skips**; strict TS/artifacts,
  syntax/version and **1,179-case** independent Ajv pass. New tests cover 10
  session, 90 run and 20 approval state/event pairs in both Node and browser,
  hostile decoded graphs and a synthetic competing-transaction model. Real
  cross-platform results require CI; the model is not database durability proof.

See [lifecycle.md](../protocol/v1/lifecycle.md) for exact transitions and required
multi-row transaction boundaries. Fresh grants/native proof verification, actual
atomic receipt/entity/event/outbox storage, full conversation projections,
generation/cursor recovery and rolling compatibility remain open. No production
restart, account/subscription change, native model call or brand change is made.
