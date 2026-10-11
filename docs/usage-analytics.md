# Usage overview

Introduced in 3.8.46.

Open **Usage** at the bottom of the Workspace sidebar. The view follows the
Workspace's selected Host when opened. Switch Hosts in the view, or choose
**All Hosts**, to combine the Hosts configured in this Workspace. Desktop and
mobile use the same authenticated Host endpoint; no additional account is
needed. The macOS App uses this same view.

Today, This week (Monday onwards), This month and 30 days use the viewing
device's time zone. Agent, project and model filters run before aggregation.
The daily chart separates uncached input, output, cache reads and cache writes;
click, focus or tap a day for its exact token count and estimated cost. Models,
Projects, Agents and Sessions show the same totals grouped in different ways.
Select a Session to return to its conversation.

## What is counted

Only sessions explicitly added to this Host's workspace registry are selected.
Supported formats are Codex rollout JSONL, Claude Code project JSONL (including
its associated subagent files), and Pi session JSONL. Other connectors show an
unsupported-session notice. Unregistered sessions and Codex/Pi subagents stored
as separate, unregistered sessions are not included. Imported history contributes
usage already present in the selected period, not just work started in Stepsemble.

- Codex uses `last_token_usage` for each observed call. Cumulative totals suppress
  repeated snapshots, and supply a fallback when per-call counts are missing.
  Fallbacks and ambiguous stale regressions mark the report incomplete. Reasoning
  tokens already included in output are not added again. Forks exclude inherited
  parent records until their own turn; independently generated sibling calls
  remain distinct.
- Claude Code deduplicates native response IDs and retains the fullest streamed
  count. Its input count excludes the separately reported cache categories.
- Pi deduplicates native entry IDs and timestamps, including inherited fork
  entries. Assistant calls and summary records with usage are included. An RPC
  process ID is not the persisted session ID.

"Model calls" means observed usage records, not HTTP requests, tool calls or
user turns. Providers may omit some records. Missing files, unsupported agents,
parse limits and incomplete token counts are shown in the view. When all selected
histories are unreadable, totals show **—**, rather than a complete zero. An
offline Host is excluded from the combined sum and named in the notice. Failed
refreshes retain a previous view only for the same selection, with an error
status; switching selection never displays another Host's old totals.

## Costs and subscription allowances

Costs are **estimates in USD, not bills**. A positive Pi-reported estimate takes
precedence; otherwise exact provider/model matches use the public
[LiteLLM reference-price catalog](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json).
Cache categories and supported long-context rates are priced independently.
Missing cache rates, mismatched providers or unknown models remain unpriced.
Pi's default zero cost for a custom/subscription model is not evidence of a free
call: reference prices are used when available, otherwise the cost is unknown.
Explicit zero reference prices and zero-token calls can still produce zero cost.

**≈** means all observed calls have an estimate, **≥** identifies the known
portion when some calls are unpriced, and **—** means no estimate is available.
Pricing coverage appears below the total. Subscription quota remaining and reset
times come from the existing Host quota sources and appear separately. Neither
estimate represents subscription charges, discounts, credits or actual invoices.

The Host caches reference prices for 24 hours in
`~/.config/stepsemble/usage-prices.json` (mode 600). Refresh failures keep the last
confirmed catalog and retry after at least five minutes. The only outbound
pricing request is for public metadata from `raw.githubusercontent.com`; no
session data, names, paths, prompts, token counts or credentials are sent.
Set `STEPSEMBLE_USAGE_PRICING_NETWORK=0` to use only the existing price cache and
agent estimates. English, Traditional Chinese and Simplified Chinese are
provided; other interface locales currently fall back to English in this view.

## Operation and limits

`GET /api/workspace/analytics` requires the ordinary Host authentication. Query
parameters are millisecond `from` (inclusive) and `to` (exclusive), IANA
`timeZone`, and optional `agent`, `project`, `model` and workspace-entry `entry`.
The maximum range is 366 days. `fresh=1` bypasses the normal 30-second report
cache, with a ten-second minimum to coalesce concurrent refreshes.

A dedicated worker reads source files without changing them or submitting agent
work. File fingerprints invalidate cached numeric records after appends or
rewrites. The worker keeps no prompt, answer or tool bodies in normalized records
or reports. File reads remain inside configured native-history roots; escaping
symlinks and non-regular files are refused. Scans are bounded to 2,000 workspace
entries, 20,000 discovered files/directories, 150,000 unique records, 512 MiB per
file, 1 GiB per scan and 16 seconds, with a 25-second worker timeout and memory
limit. Hitting a scan limit produces a partial report, never a silently complete
total. A final unfinished JSONL line is counted after it is finished.

The view refreshes once per minute while open and visible, preserving keyboard
focus and scroll position. Closing it stops the refresh timer. Quota sources
retain their existing behavior; the analytics reader itself never launches a
native harness or sends a model prompt. Reading analytics is safe during work.
At most eight distinct report requests are queued per Host; repeated requests
for the same view share a result.

## Verification and preview

```sh
npm run test:usage
npm run check:usage
npm run preview:usage
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
