# Claude snapshot observation performance — 2026-09-07

Reserved reference only; not deployed or connected to the Web history UI.
[Raw measurements](baselines/claude-history-performance-2026-09-07-darwin-arm64.json)
retain exact implementation hashes, base commit and **dirty=true**. The measured
uncommitted implementation is identified by those hashes, not by the base commit
alone. Darwin 25.6.0 arm64, Node 22.22.3, 10 logical CPUs; three sequential local
runs per case/mode, alternating order, fresh Node worker each read. OS file cache
was not flushed. All sources are newly created synthetic fixtures; model calls=0,
source bytes unchanged and owned-child/fixture cleanup confirmed.

```sh
node scripts/benchmark-claude-history.mjs /absolute/reviewed/sdk.mjs
```

The SDK must already be available and match the pinned 0.3.259 SHA-256. The
benchmark does not download/install an SDK, read private sessions or run an agent.

## Results

The large source contains 2,000 records / 7,592,414 bytes, each with 3,500 ASCII
content bytes. The observation requests the final 25 selected messages. `capture`
returns the entire raw snapshot; `observe` additionally loads the official SDK,
selects the branch/page and maps content in the worker. These are **different
amounts of work**, not a claim that total latency improved.

| Metric, min–max of three runs | Whole snapshot | Observed 25-message page |
| --- | ---: | ---: |
| Parent close handler: decode/validate/settle | 42.802–45.479 ms | 0.745–0.873 ms |
| Parent 5 ms timer's maximum observed gap | 46.124–48.932 ms | 6.308–6.652 ms |
| Whole request including owned-child close | 148.226–152.552 ms | 266.002–271.378 ms |
| Worker wire response | 7,593,121 bytes | 100,357–100,358 bytes |

The mapped page avoids shipping and synchronously re-decoding the complete
source in the parent. Whole-source parsing and mapping still happen in the child
on **every page**; pagination is not a source-index/cache optimization.

- Small case: 200 records / 110,313 bytes, page of 100; observation takes
  121.709–123.964 ms, with parent close handler 1.177–1.937 ms.
- Large observation worker reports `resourceUsage().maxRSS` of
  211,248–213,600 KiB (about 206–209 MiB) at mapping completion. The 128 MiB V8
  old-space flag is **not an RSS ceiling**. Two simultaneous workers, memory
  pressure, repeated reads, slow disks and a long-lived service need more tests.
- Asking for 100 large messages exceeds the **256 KiB whole-frame cap**. All
  three runs return `source_observation_too_large`, only 303 wire bytes, after
  confirmed child close. No partial message/page is published. A later explicit
  smaller-page request can succeed; there is no automatic retry.

## Interpretation and remaining gates

This is evidence of reduced parent-thread work for this bounded synthetic path,
not an INP/LCP, production control-API or native-client smoothness acceptance.
Both small and large complete observations exceed 100 ms. The close-handler
measurement includes decode, validation and settlement, not an exclusive CPU
profile. Five-millisecond timer gaps include scheduler variation. Parent RSS is
sampled, may miss peaks, includes fixture creation and earlier runs, and cannot
be used to infer a memory leak or clean per-mode RSS improvement.

Selection uses the public alpha `getSessionMessages({sessionStore})` interface
from the **same captured records**; no SDK transcript rediscovery occurs. Its
disposable copy protects original compaction parents. At this initial measurement
there was no version fence between page requests. Plan 1.39 adds the source-version
checks described below; it does not preserve old snapshots or freeze native writes.
Authenticated registration, Client integration, ACL/descriptor-relative containment
and durable publication remain prerequisites.

Windows source reads remain explicitly unsupported. All-OS synthetic SDK
SessionStore contracts do not establish a Windows ACL gate. `publishable`,
source authentication, approval ACK, run completion and resume authority all
remain false. See [the reader boundary](../protocol/native/claude/README.md).

## Dual-worker versioned pages — Plan 1.39

[Raw repeated-read experiment](baselines/claude-history-concurrency-2026-09-07-darwin-arm64.json)
records a different implementation/benchmark with exact hashes and dirty=true,
retaining two separately labeled workload contexts rather than pooling them.
Run `node scripts/benchmark-claude-history-concurrency.mjs /absolute/pinned/sdk.mjs`.
Do not merge these numbers with the previous measurement as one percentile.

One shared source service, two separately bound synthetic files, each containing
2,000 records / 7,592,414 bytes. Twelve sequential rounds open **two workers at
once**, reading 25-message pages; rounds 2–12 use the version token returned by
round 1. All 24 reads validate source hash, session identity, selected messages
and token consistency. Every round observes two active workers and rejects a
third request without spawning it, then confirms both workers closed and all
slots were released. SDK/source hashes are unchanged and fixture cleanup passed.

| Metric across 12 rounds / 24 workers | Observed range |
| --- | ---: |
| Complete two-read round | 282.638–288.607 ms |
| Individual parent close handler | 0.634–1.860 ms |
| Maximum parent timer gap per round | 6.351–6.933 ms |
| Parent sampled peak RSS per round | 107.234–119.359 MiB |
| Sum of two worker-reported RSS high-water values | 414.734–427.422 MiB |

The table uses the run after the local test suite finished. An earlier run of the
same final implementation overlapped with the complete 429-test suite; it is also
retained, including the less favorable numbers: round latency 283.176–634.014 ms,
parent close handler up to 4.181 ms and timer gaps up to 10.539 ms. All its 24 reads
and cleanup checks also passed. This shows load-sensitive latency, not a controlled
CPU/OS-memory-pressure experiment; the separate production service and fixed
72-hour soak continued during both contexts.

The summed high-water values are **not a simultaneous total-RSS sample**: each
worker reports its process high-water at mapping completion. Parent RSS sampling
can miss peaks and includes fixture construction/earlier allocations and deferred
GC. These short local observations do not establish absence of leaks, a hard
memory ceiling, OS low-memory behavior, slow-disk reliability, responsiveness on
weaker hardware or production/browser acceptance. No memory-exhaustion stressor
was used alongside the user's running production service/72-hour test.

This confirms bounded two-worker admission and successful version-checked paging
on the measured fixtures, while retaining a substantial worker-memory cost. Next
work: reduce avoidable whole-source copies with unchanged-content golden tests,
measure the same workload again, and add Client-side same-version assembly before
connecting this reference to a real history view. Native source authentication,
platform ACL/descriptor containment and durable/live authority remain unverified.
