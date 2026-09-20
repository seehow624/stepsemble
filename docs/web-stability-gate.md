# Web stability gate

Status: active from Stepsemble 3.0.75 development after Jerome selected the Web
app as the only current product focus. Native application expansion is deferred;
Web/PWA remains a first-class product rather than a temporary shell.

## What the rolling gate now proves

`scripts/web-stability-browser-cases.mjs` runs in the existing pinned Playwright
runtime and uses only disposable local data. Each desktop and mobile case creates
301 sessions containing 41,000 messages, including one 5,000-message history.
It verifies:

- the grouped session list renders only its three-row preview while retaining the
  authoritative count;
- the latest 300 messages open within a deliberately generous CI budget and keep
  the page below a bounded DOM ceiling;
- loading another 300 messages preserves the reader's visible position and stays
  below the second DOM ceiling;
- neither desktop nor mobile creates horizontal page overflow;
- desktop reload restores the conversation while a mobile relaunch returns to
  Sessions;
- browser page errors, external requests, native credentials, and model calls are
  absent.

The gate is part of `npm run test:rolling`, so it runs in the rolling browser
workflow on macOS and Linux together with released-client compatibility.

## First local evidence

On OneStep-MacMini with Chromium 153 and Stepsemble 3.0.75 source:

| Case | Open latest 300 | Load older 300 | Initial DOM | Paged DOM | Max observed long task |
| --- | ---: | ---: | ---: | ---: | ---: |
| Desktop 1440×1000 | 286 ms | 233 ms | 5,124 | 9,174 | 162 ms |
| Mobile 390×844 | 288 ms | 246 ms | 5,124 | 9,174 | 174 ms |

These are single local synthetic observations, not field percentiles or Core Web
Vitals. The hard budgets are regression tripwires, not claims that rendering is
already frame-perfect.

## Separate evidence still required

- repeatable Chrome DevTools traces with LCP, CLS, INP and standardized TBT;
- physical iPhone/iPad Safari background, foreground, keyboard and PWA recovery;
- slow and interrupted WAN between a mobile client and a remote Host;
- multi-hour current-version soak with real foreground/background transitions;
- memory profiling after many older-history pages, followed by virtualization if
  real usage crosses the current bounded-page assumptions.
