# Usage overview

Introduced in 3.8.46.

Open the **quota strip** at the bottom of the Workspace sidebar. The shared
**Limits & usage** panel opens on **Limits**; switch to **Usage** for history
charts and breakdowns. Both tabs keep the same panel dimensions and Host
selection. Choosing an individual Host updates the Workspace selection too;
**All Hosts** combines the readings without replacing the Workspace Host.
The panel follows later Workspace Host changes and starts on the selected
Host every time it opens. Switch Hosts in the view, or choose
**All Hosts**, to combine the Hosts configured in this Workspace. Desktop and
mobile use the same authenticated Host endpoint; no additional account is
needed. The macOS App uses this same view.

Limits groups providers into compact rows, with small service logos and
allowance windows side by side. On phones the service identity sits above
two columns of windows. By default, percentages show remaining allowance; progress-bar
labels retain the full accessible description. **Remaining / Used** switches
the percentages and bars between remaining allowance and consumed allowance.
The sidebar percentages and hover details follow the same choice, stored on
this device/browser. Low-allowance warnings always follow the amount remaining.
Switching this display does not make a provider request or change statistics.
The shared desktop panel is
900 × 680 pixels at most; both tabs preserve the same geometry and scroll
inside it when needed.

Today, This week (Monday onwards), This month and 30 days use the viewing
device's time zone. Agent, project and model filters run before aggregation.
The daily chart separates uncached input, output, cache reads and cache writes;
click, focus or tap a day for its exact token count and estimated cost. Models,
Projects, Agents and Sessions show the same totals grouped in different ways.
Select an added Session to return to its conversation. Select an unregistered
native Session to filter its usage in place; a removable Session chip identifies
the filter. This does not import a conversation or start an agent.

## What is counted

The default is **this computer's readable native history**, including work done
directly in a terminal or another App. Sessions do not need to be added to
Stepsemble. The Host scans the current user's Codex `sessions` and
`archived_sessions`, Claude Code `projects` (including subagents), and Pi
`agent/sessions`. Configured Codex/Claude history roots are respected. These
three formats are supported; other registered connectors show an unsupported
notice. Deleted histories and formats without usable token counts cannot be
reconstructed. Totals describe available records in the selected period.

Hosts on an older version still report workspace-only scope. The combined view
identifies mixed scope instead of implying that every Host has complete
computer-wide statistics.

- Codex uses `last_token_usage` for each observed call. Cumulative totals suppress
  repeated snapshots, and supply a fallback when per-call counts are missing.
  Fallbacks and ambiguous stale regressions mark the report incomplete. Reasoning
  tokens already included in output are not added again. Forks exclude inherited
  parent records until their own turn; independently generated sibling calls
  remain distinct.
- Claude Code deduplicates native response IDs and retains the fullest streamed
  count. Its input count excludes the separately reported cache categories.
- Pi reads native sessions and the foreground/background child transcripts and
  raw child events saved in `subagent-artifacts`. Completed assistant responses
  use their original timestamp and a content digest to deduplicate exports,
  native copies and inherited fork calls; no content is retained in the index.
  Older records and summaries retain native entry IDs as their identity fallback.
  Parallel children keep their own history identity even when they share a run
  ID. Assistant calls and summary records with usage are included. An RPC
  process ID is not the persisted session ID. Artifact metadata totals and partial
  streaming messages are not counted a second time.

"Model calls" means observed usage records, not HTTP requests, tool calls or
user turns. Providers may omit some records. Missing files, unsupported agents,
parse limits and incomplete token counts are shown in the view. When all selected
histories are unreadable, totals show **—**, rather than a complete zero. An
offline Host is excluded from the combined sum and named in the notice. Failed
refreshes retain a previous view only for the same selection, with an error
status; switching selection never displays another Host's old totals.

The histories-read count and history warnings cover **all saved dates**, before
usage-period and model/project filters. They do not imply that an unreadable
history belongs to the selected period or that its conversation cannot run.
Expand **View history issues** for up to 100 file-level issues per Host, including
the name, Host, path and reason: missing file, permission denied, unsupported
format, mismatched identity, malformed records, truncation or reading limits.
Deleted history still requires recovering its original file or a backup; the
reader does not fabricate its usage or remove its Workspace registration.

## Costs and subscription allowances

Costs are **estimates in USD, not bills**. A positive Pi-reported estimate takes
precedence; otherwise the original vendor/model is resolved before consulting the public
[LiteLLM reference-price catalog](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json).
OpenCodex, OpenCode Go and OpenAI-compatible transport names do not prevent
OpenAI, Anthropic, MiniMax, Z.AI or DeepSeek reference prices from matching.
Nested vendor IDs and OpenCodex's reversible Claude Code picker aliases are
recognized. Unknown custom providers are not silently equated with a vendor.
Cache categories and supported long-context rates are priced independently.
Missing cache rates, mismatched providers or unknown models remain unpriced.
Pi's default zero cost for a custom/subscription model is not evidence of a free
call: reference prices are used when available, otherwise the cost is unknown.
Explicit zero reference prices and zero-token calls can still produce zero cost.

Published GLM-5.3/Flash/FlashX and DeepSeek-V4.1-Flash rates supplement missing
catalog rows, verified on 2026-10-11 against [Z.AI pricing](https://docs.z.ai/guides/overview/pricing)
and [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/).
DeepSeek uses the standard peak reference rate, without inferring off-peak or
holiday discounts from routed histories. Published thresholds, including
Claude Haiku's 100K tier, are read from the price table.
OpenAI and Claude reference rows were checked against the official
[GPT-6.1 Sol model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
and [Claude Opus 5.5 pricing](https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5).
An unannounced preview price is not replaced by another generation's price:
MiniMax-M3.1-Flash-Preview remains unpriced unless a positive agent estimate or
an exact published catalog price is available.

**≈** means all observed calls have an estimate, **≥** identifies the known
portion when some calls are unpriced, and **—** means no estimate is available.
Pricing coverage appears below the total. Subscription quota remaining and reset
times come from the existing Host quota sources and appear in **Limits**. Neither
estimate represents subscription charges, discounts, credits or actual invoices.

The Host caches reference prices for 24 hours in
`~/.config/stepsemble/usage-prices.json` (mode 600). Refresh failures keep the last
confirmed catalog and retry after at least five minutes. The only outbound
pricing request is for public metadata from `raw.githubusercontent.com`; no
session data, names, paths, prompts, token counts or credentials are sent.
Set `STEPSEMBLE_USAGE_PRICING_NETWORK=0` to use the existing price cache, bundled
verified rates and agent estimates without fetching public metadata. English,
Traditional Chinese and Simplified Chinese are
provided; other interface locales currently fall back to English in this view.

## Operation and limits

`GET /api/workspace/analytics` requires the ordinary Host authentication. Query
parameters are millisecond `from` (inclusive) and `to` (exclusive), IANA
`timeZone`, and optional `agent`, `project`, `model` and Session `entry`.
The default `scope=machine` includes unregistered native Sessions. The explicit
legacy `scope=workspace` remains available for existing readers.
The maximum range is 366 days. `fresh=1` bypasses the normal 30-second report
cache, with a ten-second minimum to coalesce concurrent refreshes.

A dedicated worker reads source files without changing them or submitting agent
work. A private numeric index in `~/.config/stepsemble/usage-index/` (mode 600)
stores counts and parser checkpoints, with saved titles and project paths. It
contains no prompt, answer or tool bodies. Fingerprints, inode identity and
stored boundary hashes distinguish unchanged files, normal appends and source
replacements/truncation. Normal appends resume from the saved offset, including
after worker idle shutdown; other changes rebuild the index. Malformed indexes
are rebuilt, and failed index writes do not discard confirmed usage.
Index version 4 stores device/inode IDs as exact decimal strings, including
64-bit file IDs, and modification times at nanosecond precision. Older indexes
rebuild once rather than trusting rounded identifiers. The native/child-response
identity separation introduced in version 3 is retained. Truncation and
record-error reasons survive cached reads and ordinary appends.

Machine scans are bounded to 20,000 discovered entries, 150,000 unique usage
records, 8 GiB per native file, 16 GiB per scan and 16 seconds, with a 25-second
worker timeout and 192 MiB heap limit. First indexing can span multiple bounded
requests; the panel names the remaining files and resumes after two seconds.
Stable incomplete histories stay explicitly partial when indexed. Directory
symlinks and non-regular files are refused. Native archive file symlinks are
accepted only for owned regular targets whose native identity matches the
UUID filename. Compressed JSONL archives currently mark coverage partial.
Pi child artifact symlinks are refused because raw events have no native header
with which to validate an external target. Structured child artifacts validate
their version, run ID, agent name and child index against the artifact filename.
Legacy workspace-only reads retain their 512 MiB/file and 1 GiB/scan limits.
A final unfinished JSONL line is counted after it is finished.

The active tab refreshes while open and visible: every two minutes for Limits,
and once per minute for Usage. Each tab retains its own scroll position;
Usage also keeps its selected period, filters and breakdown when switching tabs.
Refresh asks for a fresh reading of only the active tab. Limits never queries
analytics, and Usage does not request quota readings. A failed quota refresh
can retain an earlier reading of that same Host, explicitly marked as cached;
changing Hosts clears the previous selection's readings. Closing the panel
stops its refresh timer and returns focus to the sidebar quota strip.
The strip remains usable when a Host reports no quota, so Usage is still
accessible. Quota-source settings open on the Host selected in the panel.
Quota sources retain their existing behavior; the analytics reader itself never launches a
native harness or sends a model prompt. Reading analytics is safe during work.
At most eight distinct report requests are queued per Host; repeated requests
for the same view share a result.

## Verification and preview

```sh
npm run test:usage
npm run check:usage
npm run preview:usage
# Include an unregistered native Pi history in the disposable preview:
node scripts/usage-preview.mjs 0 --machine
```

The preview starts two isolated loopback Hosts with synthetic histories, prices
and quota values. Its printed access token belongs only to these disposable
fixtures. It cannot start an agent, read a user's credentials or change native
histories. Its sample calendar is pinned to Asia/Kuala_Lumpur independently of
the runner's time zone. Stop it with Ctrl+C.

The headless browser cases use the test-only Playwright runtime prepared by the
rolling-client checks. They are part of the core rolling suite, or can be run
alone with an absolute runtime path:

```sh
node scripts/usage-browser-cases.mjs /absolute/path/to/isolated-playwright-runtime
```

The design takes inspiration from TokenBar's separation of observed usage,
reference costs and subscription limits. Stepsemble's implementation is a
JavaScript Host worker and browser view; it does not depend on TokenBar's Rust
engine. No production Host, updater or installed macOS App is changed by the
preview or tests. The normal release-version workflow updates the service-worker
cache and asset version queries together.

Verified on 2026-10-11 on OneStep-MacMini: all 23 focused usage tests passed;
the full suite passed 1,987 tests with five platform skips and no failures.
All 28 core rolling-browser cases passed. The latest standalone desktop and
390-pixel Traditional Chinese phone cases also verified opening a Session on
its original Host, with no model work submitted. A read-only check of this
machine's seven registered Codex, Claude Code and Pi sessions found no missing,
unsupported or partial histories; pricing networking was disabled for that check.

The shared Limits/Usage panel was verified on 2026-10-11 on OneStep-MacMini
with 52 focused tests and the desktop/390-pixel Traditional Chinese browser
cases. They cover lazy analytics, synchronized Hosts, fixed panel/header sizes,
cached and unavailable quota readings, source settings, cross-tab stale
responses, period-control focus, independent scroll positions and stopped
refresh timers after close. The desktop preview was also checked through
Computer Use. Phone coverage is an emulated viewport, not a physical iPhone.

Computer-wide history and vendor price resolution were verified on 2026-10-11
on OneStep-MacMini with 30 focused tests and the standalone desktop/390px phone
browser cases. Cases cover unregistered histories, archived Codex work,
subagents/fork deduplication, private numeric caches, malformed caches,
incremental reads across worker restarts, transport/Claude alias prices and
the 100K price tier. Browser cases also cover automatic indexing continuation
and filtering a native Session across Hosts without starting model work.
The full suite passed 1,994 tests with five platform skips and no failures;
`check:workspace` and `git diff --check` also passed.
A read-only scan of about 5.8 GB of local Codex history plus Claude/Pi histories
completed initial indexing in two requests, then took 457 ms and 268 ms on warm
views. It included 82 unregistered Sessions in the 30-day period and preserved
existing missing/partial warnings. Numeric index inspection found no transcript
body fields. This is local source validation, not deployment or a new App release.
