# Browser performance baseline — 2026-09-05

Measured Stepsemble 3.0.3 with Chrome DevTools MCP, Chrome 152 on macOS.
Production JS/CSS/server were unchanged. See [MCP evidence](baselines/browser-performance-2026-09-05.json).
These are single-run laboratory observations, not field percentiles or proof of
official-client parity. Measurement completion is separate from passing the
future performance targets.

## Reproduction

Run `node scripts/browser-performance-host.mjs`. It creates a private temporary
home with the existing Host benchmark workload (301 sessions, 41,000 messages;
the longest session has 5,000 messages). It binds an ephemeral loopback port and
uses `test-support/synthetic-pi.cjs` instead of a provider-backed Pi process.
Ctrl-C stops the fixture server and removes only its generated temporary home.

Open the printed URL in a separate Chrome browser context. Sign in through the
local first-run key flow; enable Show temporary sessions, disable grouping, and
finish onboarding. Use 1440 × 900, DPR 1, CPU 1× for desktop. Record reload,
opening Synthetic long history, Load earlier messages, and sending a synthetic
prompt. The fake Pi emits 600 text deltas at 50 ms intervals, then completes.
Use 390 × 844, DPR 3, touch/mobile emulation and CPU 4× for the mobile reload
with that long session remembered. Network is unthrottled in every recording.

Use `performance_start_trace` / `performance_stop_trace`, PerformanceObserver
for long tasks and paint entries, network inspection, an accessibility snapshot,
and Lighthouse snapshot audits. Trace exports to both the repository and local
artifact directory were rejected by this MCP server's workspace-path policy;
the JSON preserves its returned trace summaries and insights, not full trace
event files. Full downloadable traces remain an evidence-export follow-up.

## Observations

| Scenario | Observation | Interpretation |
| --- | --- | --- |
| Desktop, warm shell, session list | LCP 672 ms; CLS 0.0246 | Fast on this host; small list/toolbar movement |
| Desktop, cleared SW cache and cache-bypass reload | LCP 502 ms, then 519 ms on the SW activation reload | Two navigations occurred; not a clean isolated one-navigation cold-start result |
| Desktop after activation reload | FCP 520 ms; 2,468 DOM elements | Paint observer belongs to the second navigation |
| Open long session (latest 300 messages) | Lab INP 537 ms; 7 ms input / 154 ms processing / 376 ms presentation | Slow interaction, priority for Phase 2 |
| Long session after open | 6,517 DOM elements; 163 and 379 ms long tasks | History render and list work need profiling/refactoring |
| Load earlier page (another 300 messages) | Lab INP 38 ms | Only this click's observed response; does not prove all asynchronous render work is short |
| Stream 600 deltas over ~30 s | All 600 received; completion exited streaming; one 479 ms long task at completion | Delta delivery works; final render still blocks |
| Mobile 4× CPU, restore long session | FCP 1,860 ms; LCP 4,859 ms; CLS ~0.12 | Restore is slow under this CPU condition; not physical-device performance |
| Mobile DOM/reflow inspection | ~6,523 elements; 303 message-container children; 88 ms forced reflow | Forced reflow points to scroll code around app.js:3880; resetProjectChanges also contributed |
| Desktop list Lighthouse snapshot | Accessibility 100; Best Practices 100 | Automatic checks of this state only |
| Mobile chat Lighthouse snapshot | Accessibility 95; Best Practices 100 | Copy/Retry contrast 3.41:1; model button visible/accessibility name mismatch |

The stream trace reports INP 533 ms, but its event timestamp precedes the trace
start and belongs to composer filling. It must not be attributed to live delta
handling. The final 479 ms long task is a separate directly observed issue.

Standardized Lighthouse TBT was **not produced** by the available performance
tool. Long-task durations are retained; do not rename their sum to TBT or fill
the missing value with zero. Physical iOS/Android, throttled WAN, multi-client
soak, background resume and memory-leak conclusions remain outside this baseline.

## Network and code findings

The shell and API use the local origin. The list load issued repeated machine,
version and agent-task requests; one task request was aborted. Its critical
request chain reached 826 ms. Chrome assigned 0 ms estimated LCP savings to
render-blocking resources, so removing them is not the priority on this host.
Warm resources can come from the service worker even when HTTP reload is used.

Observed decoded sizes: app.js 470,952 bytes; i18n.js 463,332 bytes; CSS 164,047
bytes. The UI is buildless, and long history is paginated in batches of 300 but
not virtualized. Start with measured interaction/DOM work, completion rendering,
initial list layout stability, and the two chat accessibility findings.

Baseline acceptance: enough evidence now exists to begin Protocol contract work;
the performance failures are recorded Phase 2 work, not a reason to claim the
current Web UI already meets the smoothness target. Missing standardized TBT and
full trace export stay explicitly open.
