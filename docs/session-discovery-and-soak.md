# Async session discovery and recovery soak

Status: development candidate 3.0.7-rc.1. Both production Hosts remain 3.0.6.
No native account/model calls, native file mutation, logo change or deployment
is part of this development test batch.

## Actual defects addressed

- List/search/usage discovery synchronously enumerated directories and resolved
  and statted every file on the sole HTTP event loop. It now uses asynchronous
  directory iterators and four metadata workers, with one shared in-flight walk.
- Concurrent list requests previously repeated parsing/cache work. Summary work
  is shared, parsed with at most four workers, and returned as separate rows so
  one request's live-state flags do not mutate another response.
- Cache checks also use ctime/inode/device, not only mtime/size. A post-read stat
  and invalidation identity check prevent restoring an entry invalidated during
  the read. The cache retains at most 10,000 summaries; this is not a list limit.
- Search's declared 400-file bound and usage's declared 8 MiB bound were unused.
  Both are now applied. A bounded read checks actual bytes, including appends
  after stat, and closes its handle on every exit. Parsing yields every128lines.
- Whole-root permission/IO failures do not become a successful empty list.
  Scans have a50,000-entry/15-second budget and return503 on overflow. A timed-out
  caller does not free the flight while filesystem work remains outstanding.

Existing native source/title/filter/API semantics remain. The module rejects
outside-root symlinks and non-files; archive directories remain hidden. This is
not a hostile-local-user filesystem sandbox. Native independent writers are not
locked. Rename/export and other synchronous request paths remain future work.

## Verification tooling

`npm run test:soak` defaults to72hours,8 synthetic terminal agents,2 independent
HTTP/SSE viewers each, one reconnect per task per30-second cycle and alternating
graceful/SIGKILL **isolated HTTP Host** restarts every20cycles. It never kills a
production Host, supervisor or persisted PID. Each input gets a unique synthetic
ACK; both streams and HTTP tail must contain it exactly once. Task identity,
child PID, original start time and synthetic peer incarnation must remain.

The runner creates its own random loopback port and private local temp home.
It accepts no arbitrary URL, existing workspace or cleanup path. Runtime source
is copied and SHA-256 frozen before starting, so later repo edits cannot change
the experiment. Long runs require a clean commit. Native credentials, proxies,
Node preloads and custom profile locations are not inherited by the Host/peers.

The status JSON is atomically replaced, bounded to the latest512samples, and
records per-Host-epoch RSS plus cumulative counters. It remains `running` until
the requested observation interval **and cleanup** finish. An observation gap
over120seconds (or four intervals, if larger) fails the run; sleeping for72hours
does not count as a pass. If the controller dies, fixture peers expire their
lease within120seconds. Normal cleanup removes only this fixture's lease and
uses the normal stop API; unconfirmed cleanup keeps the fixture for inspection.
Reports and frozen source remain local, not automatically uploaded.

Short reproduction:

```sh
npm run test:soak -- --duration-seconds 30 --interval-ms 100 --restart-every 2 --tasks 8
```

Regular CI contains a shorter8-task case on all three OSes. This is a harness
regression, not a substitute for72hours. Report actual run IDs, counts, dates,
source hashes and any skips/failures separately.

## Evidence so far

- New local discovery tests cover real files/symlinks/limits, concurrent slow
  metadata, caller timeout without duplicate work, handle cleanup, UTF-8/growth,
  same-size replacement and actual HTTP list/search/usage.
- Initial8-second local recovery experiment:19cycles,152ACKs,5graceful and4crash
  HTTP restarts,8surviving tasks/16viewers; fixture cleanup confirmed. This was a
  dirty development snapshot and is not the eventual clean-source soak result.
- An initial preflight failed because the frozen source lacked `protocol/`;
  added that runtime dependency and reran successfully. It was a test fixture
  failure, not a production outage.
- Syntax, strictTS/client artifact, protocol artifact,1251-case Ajv and version
  checks passed before version finalization. New exact-source CI/rolling,
  repeated Host measurements and full72-hour result are still required.

### Clean-source acceptance (2026-09-06)

- Source `2b7f0b652634a30cb546aceb27339cdad140efc0` is committed/pushed.
  [CI34030379708](https://github.com/seehow624/stepsemble/actions/runs/34030379708)
  passed346tests on each OS: macOS344pass/2skip, Windows336/10, Linux343/3,
  zero failures. Both the actual8-task Host recovery case and HTTP discovery
  case ran successfully on all three systems; they were not platform skips.
- [Rolling34030379721](https://github.com/seehow624/stepsemble/actions/runs/34030379721)
  passed15cases each on macOS/Linux:8real-source historical pairings,2auth UI,
  2Pi-session UI and3nested folder-picker viewports. These are Chromium tests,
  not physical mobile evidence. StrictTS/artifact/Ajv gates passed in CI.
- Three sequential clean-source Host benchmarks are preserved in
  [`baselines/host-performance-2026-09-06-stepsemble-3.0.7-rc.1-darwin-arm64.json`](baselines/host-performance-2026-09-06-stepsemble-3.0.7-rc.1-darwin-arm64.json).
  Cold list89.744–91.907ms; warm-list per-run p95 7.319–7.485ms;
  invalidated scan91.904–92.785ms; concurrent health max4.944–5.184ms.
  Each report identifies source/hash/dirty=false and uses the same301-session,
  41,000-message/8-task workload. These are not a controlled old/new A/B, not
  browser INP, and not a global p95 made from only three runs.
- After-workload RSS123.891–126.172MiB, versus97.719MiB in the earlier single
  3.0.6 report. Concurrent parsing may increase the high-water mark; do not claim
  a memory improvement or absence of leaks from these short measurements.
- Public stable and both installed production versions are still3.0.6.
  The candidate is ready for the isolated long-duration gate, not yet certified
  by72hours and not automatically promoted to stable.

## Remaining boundaries

This does **not** certify complete native Claude/Codex/Grok/OpenCode session,
history, approval, tool or model behavior. Existing generic output remains a
64KiB tail; finite replay/snapshot replacement is not durable full history.
Input delivery is not a durable exactly-once transaction. Pi ownership across
Host restart remains separate. Real mobile/background/network/power-loss,
whole-Host restore, and uninterrupted single-process memory-leak certification
are not covered. Rust/App phases retain the accepted plan's prior gates.
