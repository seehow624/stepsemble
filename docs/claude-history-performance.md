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
disposable copy protects original compaction parents. There is still no
version-pinned multi-page cursor: concurrent native writes between requests can
change source SHA/identity and selected order. A future Client must not concatenate
different source versions; authenticated registration, source-version fencing,
ACL/descriptor-relative containment and durable publication remain prerequisites.

Windows source reads remain explicitly unsupported. All-OS synthetic SDK
SessionStore contracts do not establish a Windows ACL gate. `publishable`,
source authentication, approval ACK, run completion and resume authority all
remain false. See [the reader boundary](../protocol/native/claude/README.md).
