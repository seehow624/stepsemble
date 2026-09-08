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

## Rejected clone trial — Plan 1.40

[Both raw trial runs](baselines/claude-history-clone-trial-2026-09-07-darwin-arm64.json)
retain the clean `7f74343155842446080f4273bf191f37fefb5668` baseline and dirty
candidate's exact file hashes, workload, cleanup and environment. The candidate
replaced the SDK's JSON round-trip clone with `structuredClone`, then cleared
the temporary records/selected references before mapping. It retained full
independent nested objects and the existing mapper validation; it did not weaken
source/content checks. The raw artifact describes the exact edits to reproduce.

| 12-round trial | Original | Candidate (reverted) |
| --- | ---: | ---: |
| Sum of worker high-water RSS, median | 421.164 MiB | 408.852 MiB |
| Sum of worker high-water RSS, min–max | 416.625–436.703 MiB | 404.016–420.531 MiB |
| Complete dual-read round, median | 283.539 ms | 296.171 ms |
| Complete dual-read round, min–max | 279.160–286.068 ms | 289.500–332.734 ms |

About 2.9% lower median summed high-water RSS accompanied about 4.5% greater
median round latency in these samples. These sequential local before/after runs
were not randomized, repeated alternating A/B trials or controlled causal proof.
Neither overlapped the local full test suite; the unchanged production service
and fixed soak continued. Each completed 24 reads/12 admission rejections with
source bytes unchanged and cleanup confirmed. No model calls occurred.

**The candidate was reverted**, not reported as a performance improvement. The
original whole-source clone remains. Nested SDK/source/observation independence
now has an additional regression test. Memory optimization is still open and
needs a better measured approach; do not repeat this rejected change without new
evidence. The earlier RSS/timing limitations all still apply.

Plan 1.40 adds bounded [Client same-version page state](../protocol/history-pages.md)
with explicit refresh/late-request fencing, not a faster reader or deployed UI.
Its 2 MiB retention cap does not include all JS allocation overhead and is not an
RSS ceiling; real browser rendering/state-copy performance remains unmeasured.


## Native reader + bytes-only worker — measured 2026-09-08

This bounded follow-up reuses `records(2000, 3500)` from the existing benchmark,
without changing selection or optimizing the workload. Two separately bound
owned files each contain **2,000 rows / 7,592,414 bytes**. Three rounds request
25-message pages; rounds 2–3 retain each binding's original version token.
Every read performs Rust capture followed by a fresh bytes-only Node SDK worker.
The Rust executable was a **debug build**, not a release-performance estimate.

```sh
node scripts/measure-native-history-pipeline.mjs /absolute/owned/helper /absolute/pinned/sdk.mjs
```

Measured on Darwin 25.6.0 arm64 / Node 22.22.3 / 10 logical CPUs at
2026-09-08T01:05:21Z. The base commit was `4c07464928ea14cefe1e355c2b83a94c8c187c69`
with **dirty=true**; exact implementation and executable hashes are retained
below. Hashes identify measured artifacts, not executed-byte authenticity.

| Round | Two-read completion | Maximum parent 5 ms timer gap | Parent sampled peak RSS | SDK child 1 / 2 high-water RSS |
| --- | ---: | ---: | ---: | ---: |
| 1 | 586.143 ms | 10.057 ms | 145.969 MiB | 207.297 / 211.938 MiB |
| 2 | 589.826 ms | 8.866 ms | 144.656 MiB | 205.359 / 202.797 MiB |
| 3 | 593.946 ms | 8.992 ms | 162.813 MiB | 207.406 / 207.422 MiB |

Physical owned-child counts, incremented at spawn and decremented only on
`close`, never exceeded **two across both Rust and Node stages**. Each round
observed two occupied composite slots and rejected a third request without
spawning. Every round then observed zero live children and free slots.

Rust response frames were 7,593,061 bytes; SDK page frames were
100,374–100,432 bytes. Parent close-handler measurements were 2.570–3.169 ms
for Rust and 0.732–1.442 ms for SDK children; these exclude subsequent promise
continuations, so timer gaps better include the handoff's additional parent work.
A separate 100-message request returned `source_observation_too_large` in a
303-byte error frame. An explicit smaller versioned request then succeeded.
Sources and artifacts were unchanged; cleanup confirmed, private reads=0,
model calls=0. No service implementation was changed for this measurement.

This is **not a demonstrated performance improvement**. These samples have higher
latency and parent sampled RSS than the earlier unloaded legacy observations,
but were not alternating controlled A/B trials: implementation, security work,
debug Rust build, and concurrent host activity differ. SDK workers still have
substantial whole-source parsing/cloning/mapping memory cost. Their per-process
high-water RSS values are **not simultaneous total RSS**, and Rust-child RSS was
not measured. Parent samples can miss peaks and include fixture construction,
previous allocations and deferred GC; the three increasing/decreasing samples
do not establish a leak or its absence. The 128 MiB old-space flag remains **not
an RSS ceiling**. No GC forcing, memory-pressure stress, OS-cache flush,
production/browser responsiveness acceptance or long-duration benchmark occurred.

<details>
<summary>Raw three-round native pipeline measurement, including exact hashes</summary>

```json
{
  "schemaVersion": 1,
  "recordedAt": "2026-09-08T01:05:21.161Z",
  "sourceCommit": "4c07464928ea14cefe1e355c2b83a94c8c187c69",
  "sourceWorktreeDirty": true,
  "implementationHashes": {
    "protocol/native/claude/history-native-service.js": "efce9f7607df82ef2e41ee90b230b2a969eec1c9716cb272747842ff9d513e25",
    "protocol/native/claude/history-native-helper.js": "c3e8f621b9d0f2b16d55731083785084d35035ae91c7eb790b5d6226bb82ae74",
    "protocol/native/claude/history-bytes-worker.js": "85342f406b393332604dfe88505bae7f2d04779affac15a13dcb437110c08de5",
    "protocol/native/claude/history-bytes-wire.js": "bd3106eac08bfdfd458d6fb6dfdea13f9c10d44041821540e1ea14d0aea54ae1",
    "protocol/native/claude/history-source.js": "dc7b39285399c57b5e2df68d382dfba1e0aa999c1f4a60f88b57434937983593",
    "protocol/native/claude/history-worker-wire.js": "9bf1d80287bb59a90bbd34b167fd8669b5fcd374eb2f1004ebf560c9af1a7772",
    "protocol/native/claude/history-record-scope.js": "30cc730be6e593d7d3c9253457b5f716b46f5c586f0623f74202269049a19f42",
    "protocol/native/claude/history-sdk.js": "c21ff336ec34190c4dd5f2c4ff9e39cc41a790cb139f96c64d59fd9de39df559",
    "protocol/native/claude/history-selection.js": "63a578543fda08025ad3a6686b65a4c67058715c5696a515f2f92e7f773164f7",
    "protocol/native/claude/history-observation.js": "fc137d0892070babcdf76ef3dec8d8b772b4dd870005a6392ded4587d5df74fa",
    "scripts/measure-native-history-pipeline.mjs": "ee8704a771ae552c8e08fadb20df8cb31ad5da414653bf8a6a805ef3226ad791",
    "scripts/benchmark-claude-history.mjs": "b3388dca34d393d69a7e3c256c949ce42be34b957c57b18f18401aabfa7f2822",
    "public/modules/projection.js": "9ca33115762e30ac35519f5ae6e52928f06743f30078cddf17fdd02cd366a760",
    "public/modules/claude-history.js": "37f205a8f9839d62598d62b3d1ef12c5879582fc3be522a9e6c1768423e1ef10",
    "public/modules/claude-history-value.js": "f7cfb68400e548b1159dcdec8ca0fbe25e5518f6dd6f917af3049ca3dbc58e58"
  },
  "helperArtifactSha256": "688a6f8c741e22c42681beab77bcbc987329860d2499ff627cf4e24c0c9b75e7",
  "environment": {
    "node": "v22.22.3",
    "platform": "darwin",
    "release": "25.6.0",
    "arch": "arm64",
    "cpuLogicalCount": 10
  },
  "sdkVersion": "0.3.259",
  "sdkSha256": "7fa7c212361864544e775e7551519e790515f95d4bb6a4831b0b05f5b368a0c5",
  "workload": {
    "sources": 2,
    "rawBytesEach": 7592414,
    "rowsEach": 2000,
    "textBytesPerRow": 3500,
    "rounds": 3,
    "simultaneousReads": 2,
    "pageMessages": 25,
    "freshChildrenPerRound": 4
  },
  "rounds": [
    {
      "round": 1,
      "page": {
        "offset": 1975,
        "limit": 25
      },
      "elapsedMs": 586.143,
      "workers": [
        {
          "elapsedMs": 586.09,
          "sdkHighWaterRssKiB": 212272,
          "selectionMs": 15.692,
          "mappingMs": 93.587
        },
        {
          "elapsedMs": 582.042,
          "sdkHighWaterRssKiB": 217024,
          "selectionMs": 11.368,
          "mappingMs": 91.565
        }
      ],
      "children": [
        {
          "stage": "rust",
          "wireBytes": 7593061,
          "parentCloseHandlerMs": 2.901
        },
        {
          "stage": "rust",
          "wireBytes": 7593061,
          "parentCloseHandlerMs": 3.169
        },
        {
          "stage": "sdk",
          "wireBytes": 100432,
          "parentCloseHandlerMs": 1.442
        },
        {
          "stage": "sdk",
          "wireBytes": 100431,
          "parentCloseHandlerMs": 0.804
        }
      ],
      "parentTimerMaxGapMs": 10.057,
      "parentTimerTicks": 96,
      "parentSampledPeakRssMiB": 145.969,
      "parentRssBeforeMiB": 117.453,
      "parentRssAfterMiB": 138.844,
      "physicalChildrenPeak": 2,
      "thirdRejectedWithoutSpawn": true,
      "cleanupConfirmed": true
    },
    {
      "round": 2,
      "page": {
        "offset": 1950,
        "limit": 25
      },
      "elapsedMs": 589.826,
      "workers": [
        {
          "elapsedMs": 589.789,
          "sdkHighWaterRssKiB": 210288,
          "selectionMs": 10.855,
          "mappingMs": 95.091
        },
        {
          "elapsedMs": 583.532,
          "sdkHighWaterRssKiB": 207664,
          "selectionMs": 11.028,
          "mappingMs": 93.371
        }
      ],
      "children": [
        {
          "stage": "rust",
          "wireBytes": 7593061,
          "parentCloseHandlerMs": 2.57
        },
        {
          "stage": "rust",
          "wireBytes": 7593061,
          "parentCloseHandlerMs": 2.67
        },
        {
          "stage": "sdk",
          "wireBytes": 100374,
          "parentCloseHandlerMs": 0.967
        },
        {
          "stage": "sdk",
          "wireBytes": 100383,
          "parentCloseHandlerMs": 0.792
        }
      ],
      "parentTimerMaxGapMs": 8.866,
      "parentTimerTicks": 96,
      "parentSampledPeakRssMiB": 144.656,
      "parentRssBeforeMiB": 138.844,
      "parentRssAfterMiB": 144.656,
      "physicalChildrenPeak": 2,
      "thirdRejectedWithoutSpawn": true,
      "cleanupConfirmed": true
    },
    {
      "round": 3,
      "page": {
        "offset": 1925,
        "limit": 25
      },
      "elapsedMs": 593.946,
      "workers": [
        {
          "elapsedMs": 584.313,
          "sdkHighWaterRssKiB": 212384,
          "selectionMs": 10.962,
          "mappingMs": 92.079
        },
        {
          "elapsedMs": 593.914,
          "sdkHighWaterRssKiB": 212400,
          "selectionMs": 13.956,
          "mappingMs": 96.057
        }
      ],
      "children": [
        {
          "stage": "rust",
          "wireBytes": 7593061,
          "parentCloseHandlerMs": 2.92
        },
        {
          "stage": "rust",
          "wireBytes": 7593061,
          "parentCloseHandlerMs": 2.638
        },
        {
          "stage": "sdk",
          "wireBytes": 100424,
          "parentCloseHandlerMs": 0.842
        },
        {
          "stage": "sdk",
          "wireBytes": 100432,
          "parentCloseHandlerMs": 0.732
        }
      ],
      "parentTimerMaxGapMs": 8.992,
      "parentTimerTicks": 97,
      "parentSampledPeakRssMiB": 162.813,
      "parentRssBeforeMiB": 144.656,
      "parentRssAfterMiB": 162.813,
      "physicalChildrenPeak": 2,
      "thirdRejectedWithoutSpawn": true,
      "cleanupConfirmed": true
    }
  ],
  "capCheck": {
    "result": "source_observation_too_large",
    "errorWireBytes": 303,
    "explicitSmallerPageRecovery": true
  },
  "physicalChildrenPeak": 2,
  "modelCalls": 0,
  "privateHistoryReads": 0,
  "sourceUnchanged": true,
  "cleanupConfirmed": true,
  "limitations": [
    "Three rounds only, existing host activity not controlled, warm OS cache, no forced GC or memory-pressure stress",
    "SDK maxRSS is per-process high-water at mapping completion, not simultaneous total RSS; Rust child RSS was not measured",
    "Parent RSS samples can miss peaks and include fixture construction and earlier allocations",
    "5ms timer gap includes scheduler effects; close handler excludes later promise continuations",
    "Not production/browser acceptance, a hard RSS ceiling, long-term leak proof, or authenticated native provenance"
  ]
}
```

</details>


### Release follow-up — minimum Node 22.19.0

A locked optimized build was made in the same existing local target directory:
`cargo build --manifest-path crates/history-source-reader/Cargo.toml --locked --release`.
The identical measurement script/workload then ran three rounds on Node 22.19.0
at 2026-09-08T01:06:40Z. No security checks or service implementation were weakened
for measurement. All six reads, three admission rejections, capped-error and
explicit smaller-page recovery checks passed; physical children again peaked
at two, source bytes unchanged and cleanup confirmed.

| Release round | Two-read completion | Maximum parent 5 ms timer gap | Parent sampled peak RSS | SDK child 1 / 2 high-water RSS |
| --- | ---: | ---: | ---: | ---: |
| 1 | 755.912 ms | 13.571 ms | 145.625 MiB | 203.281 / 200.938 MiB |
| 2 | 319.671 ms | 10.900 ms | 144.453 MiB | 207.969 / 203.234 MiB |
| 3 | 317.553 ms | 8.649 ms | 162.781 MiB | 205.625 / 202.453 MiB |

The slower first round is retained, not discarded as warmup. SDK frames remained
100,365–100,432 bytes, and the large-page error remained 303 bytes.
Rust close-handler measurements were 2.530–4.872 ms; SDK close handlers were
0.715–1.624 ms. The release helper hash was
`e2368ef16e1def5a43baf064b81da98aad107946bc1f7cdebd0507fd49c33d02`.

This is **not a controlled debug-versus-release or native-versus-legacy A/B**:
the Node version differs, the recorded base commit advanced to
`d3e2fe1cbb8818e4b5d4850a7d8285897fc25d99`, the helper-adapter source hash changed,
and surrounding host work was uncontrolled. Each run checked its own runtime
hashes for drift while measuring. Later release rounds were faster than this
debug sample, but this does not identify the cause of every difference or justify
discarding the first round. SDK per-process RSS still exceeds 200 MiB, with no
established reduction in memory cost or parent-RSS ceiling. All sampling,
non-simultaneous high-water, no-Rust-RSS and no-production-acceptance limitations
above continue to apply.

<details>
<summary>Raw release / Node 22.19.0 measurement, including exact hashes</summary>

```json
{
  "schemaVersion": 1,
  "recordedAt": "2026-09-08T01:06:40.747Z",
  "sourceCommit": "d3e2fe1cbb8818e4b5d4850a7d8285897fc25d99",
  "sourceWorktreeDirty": true,
  "implementationHashes": {
    "protocol/native/claude/history-native-service.js": "efce9f7607df82ef2e41ee90b230b2a969eec1c9716cb272747842ff9d513e25",
    "protocol/native/claude/history-native-helper.js": "b61d95c3291fc438e4a426f42ffce13f1a2fa2948794d445b58e99640dc4c733",
    "protocol/native/claude/history-bytes-worker.js": "85342f406b393332604dfe88505bae7f2d04779affac15a13dcb437110c08de5",
    "protocol/native/claude/history-bytes-wire.js": "bd3106eac08bfdfd458d6fb6dfdea13f9c10d44041821540e1ea14d0aea54ae1",
    "protocol/native/claude/history-source.js": "dc7b39285399c57b5e2df68d382dfba1e0aa999c1f4a60f88b57434937983593",
    "protocol/native/claude/history-worker-wire.js": "9bf1d80287bb59a90bbd34b167fd8669b5fcd374eb2f1004ebf560c9af1a7772",
    "protocol/native/claude/history-record-scope.js": "30cc730be6e593d7d3c9253457b5f716b46f5c586f0623f74202269049a19f42",
    "protocol/native/claude/history-sdk.js": "c21ff336ec34190c4dd5f2c4ff9e39cc41a790cb139f96c64d59fd9de39df559",
    "protocol/native/claude/history-selection.js": "63a578543fda08025ad3a6686b65a4c67058715c5696a515f2f92e7f773164f7",
    "protocol/native/claude/history-observation.js": "fc137d0892070babcdf76ef3dec8d8b772b4dd870005a6392ded4587d5df74fa",
    "scripts/measure-native-history-pipeline.mjs": "ee8704a771ae552c8e08fadb20df8cb31ad5da414653bf8a6a805ef3226ad791",
    "scripts/benchmark-claude-history.mjs": "b3388dca34d393d69a7e3c256c949ce42be34b957c57b18f18401aabfa7f2822",
    "public/modules/projection.js": "9ca33115762e30ac35519f5ae6e52928f06743f30078cddf17fdd02cd366a760",
    "public/modules/claude-history.js": "37f205a8f9839d62598d62b3d1ef12c5879582fc3be522a9e6c1768423e1ef10",
    "public/modules/claude-history-value.js": "f7cfb68400e548b1159dcdec8ca0fbe25e5518f6dd6f917af3049ca3dbc58e58"
  },
  "helperArtifactSha256": "e2368ef16e1def5a43baf064b81da98aad107946bc1f7cdebd0507fd49c33d02",
  "environment": {
    "node": "v22.19.0",
    "platform": "darwin",
    "release": "25.6.0",
    "arch": "arm64",
    "cpuLogicalCount": 10
  },
  "sdkVersion": "0.3.259",
  "sdkSha256": "7fa7c212361864544e775e7551519e790515f95d4bb6a4831b0b05f5b368a0c5",
  "workload": {
    "sources": 2,
    "rawBytesEach": 7592414,
    "rowsEach": 2000,
    "textBytesPerRow": 3500,
    "rounds": 3,
    "simultaneousReads": 2,
    "pageMessages": 25,
    "freshChildrenPerRound": 4
  },
  "rounds": [
    {
      "round": 1,
      "page": {
        "offset": 1975,
        "limit": 25
      },
      "elapsedMs": 755.912,
      "workers": [
        {
          "elapsedMs": 755.871,
          "sdkHighWaterRssKiB": 208160,
          "selectionMs": 11.202,
          "mappingMs": 95.564
        },
        {
          "elapsedMs": 754.873,
          "sdkHighWaterRssKiB": 205760,
          "selectionMs": 11.37,
          "mappingMs": 93.202
        }
      ],
      "children": [
        {
          "stage": "rust",
          "wireBytes": 7593061,
          "parentCloseHandlerMs": 4.872
        },
        {
          "stage": "rust",
          "wireBytes": 7593061,
          "parentCloseHandlerMs": 3.828
        },
        {
          "stage": "sdk",
          "wireBytes": 100432,
          "parentCloseHandlerMs": 0.915
        },
        {
          "stage": "sdk",
          "wireBytes": 100432,
          "parentCloseHandlerMs": 1.624
        }
      ],
      "parentTimerMaxGapMs": 13.571,
      "parentTimerTicks": 123,
      "parentSampledPeakRssMiB": 145.625,
      "parentRssBeforeMiB": 117.156,
      "parentRssAfterMiB": 138.578,
      "physicalChildrenPeak": 2,
      "thirdRejectedWithoutSpawn": true,
      "cleanupConfirmed": true
    },
    {
      "round": 2,
      "page": {
        "offset": 1950,
        "limit": 25
      },
      "elapsedMs": 319.671,
      "workers": [
        {
          "elapsedMs": 319.638,
          "sdkHighWaterRssKiB": 212960,
          "selectionMs": 11.744,
          "mappingMs": 91.392
        },
        {
          "elapsedMs": 315.902,
          "sdkHighWaterRssKiB": 208112,
          "selectionMs": 14.644,
          "mappingMs": 94.497
        }
      ],
      "children": [
        {
          "stage": "rust",
          "wireBytes": 7593061,
          "parentCloseHandlerMs": 2.818
        },
        {
          "stage": "rust",
          "wireBytes": 7593061,
          "parentCloseHandlerMs": 2.674
        },
        {
          "stage": "sdk",
          "wireBytes": 100365,
          "parentCloseHandlerMs": 0.874
        },
        {
          "stage": "sdk",
          "wireBytes": 100374,
          "parentCloseHandlerMs": 0.715
        }
      ],
      "parentTimerMaxGapMs": 10.9,
      "parentTimerTicks": 54,
      "parentSampledPeakRssMiB": 144.453,
      "parentRssBeforeMiB": 138.578,
      "parentRssAfterMiB": 144.453,
      "physicalChildrenPeak": 2,
      "thirdRejectedWithoutSpawn": true,
      "cleanupConfirmed": true
    },
    {
      "round": 3,
      "page": {
        "offset": 1925,
        "limit": 25
      },
      "elapsedMs": 317.553,
      "workers": [
        {
          "elapsedMs": 317.521,
          "sdkHighWaterRssKiB": 210560,
          "selectionMs": 14.678,
          "mappingMs": 95.067
        },
        {
          "elapsedMs": 312.601,
          "sdkHighWaterRssKiB": 207312,
          "selectionMs": 15.059,
          "mappingMs": 94.733
        }
      ],
      "children": [
        {
          "stage": "rust",
          "wireBytes": 7593061,
          "parentCloseHandlerMs": 2.53
        },
        {
          "stage": "rust",
          "wireBytes": 7593061,
          "parentCloseHandlerMs": 2.782
        },
        {
          "stage": "sdk",
          "wireBytes": 100432,
          "parentCloseHandlerMs": 0.853
        },
        {
          "stage": "sdk",
          "wireBytes": 100432,
          "parentCloseHandlerMs": 0.744
        }
      ],
      "parentTimerMaxGapMs": 8.649,
      "parentTimerTicks": 53,
      "parentSampledPeakRssMiB": 162.781,
      "parentRssBeforeMiB": 144.453,
      "parentRssAfterMiB": 162.781,
      "physicalChildrenPeak": 2,
      "thirdRejectedWithoutSpawn": true,
      "cleanupConfirmed": true
    }
  ],
  "capCheck": {
    "result": "source_observation_too_large",
    "errorWireBytes": 303,
    "explicitSmallerPageRecovery": true
  },
  "physicalChildrenPeak": 2,
  "modelCalls": 0,
  "privateHistoryReads": 0,
  "sourceUnchanged": true,
  "cleanupConfirmed": true,
  "limitations": [
    "Three rounds only, existing host activity not controlled, warm OS cache, no forced GC or memory-pressure stress",
    "SDK maxRSS is per-process high-water at mapping completion, not simultaneous total RSS; Rust child RSS was not measured",
    "Parent RSS samples can miss peaks and include fixture construction and earlier allocations",
    "5ms timer gap includes scheduler effects; close handler excludes later promise continuations",
    "Not production/browser acceptance, a hard RSS ceiling, long-term leak proof, or authenticated native provenance"
  ]
}
```

</details>
