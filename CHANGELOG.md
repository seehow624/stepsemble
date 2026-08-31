# Changelog

## 2.2.7

- The context gauge is now the only composer indicator: the ring (still
  state-colored) opens the usage popover on tap, and all token figures live
  inside it, replacing the separate exclamation button.
- Added a provider-accounts section to that popover: for configured paid
  providers with a known quota API (DeepSeek, OpenRouter, SiliconFlow) it
  shows the remaining balance; providers without one are marked honestly.
  Queries run host-side against allowlisted endpoints, cache for ten minutes,
  and never return credentials or raw provider payloads.

## 2.2.6

- Added a read-only project Changes inspector with a changed-file badge,
  staged and working-tree diffs, Git-safe path scoping, desktop split view,
  mobile file-to-detail navigation, and complete copy in all 11 locales.
- Prevented the generic locale pass from re-translating Traditional Chinese
  chrome, eliminating mixed strings such as `work階段`, `五min`, and
  `MorePROJECT操作`; the fully localized setup guide is now isolated from the
  generic DOM translator.
- Added bounded, automatically saved composer drafts scoped by device and
  session, so switching conversations restores each draft independently instead
  of carrying one prompt into another chat.
- Split the mobile setup guide into an independently scrolling content area and
  a fixed action area, keeping every instruction visible above Continue.
- Kept the 320px composer inside the viewport by collapsing its inline context
  numbers to the existing progress ring while retaining full details in the
  accessible usage popover.

## 2.2.5

- Fixed chat image enlarging: tapping or clicking a chat image never opened
  the viewer because the gallery handler re-normalized an already-normalized
  attachment and silently rejected it. Normalization is now idempotent, so
  sent and received images open full-screen again, with a regression test.
- The context ring and its numbers now sit directly beside the usage-details
  button on the right, leaving the free toolbar space between the model chip
  and the indicator.

## 2.2.4

- The context progress bar became a compact circular progress ring beside the
  usage numbers, keeping the toolbar to a single slim row; warning (>70%)
  and critical (>90%) colors are unchanged.
- Cache write now shows an em dash with an explanatory tooltip when a provider
  reports no cache writes (most OpenAI-compatible providers only report cache
  hits) instead of a bare 0.

## 2.2.3

- Rebuilt the composer toolbar into one row: attachment button on the left, a
  fixed-width model chip next to it, the context progress bar beside Send, and
  an exclamation button that opens a usage-details popover.
- The model chip keeps a constant size and truncates overlong model names with
  an ellipsis while always keeping the trailing thinking level (for example
  "DeepSeek V3 Fla… · max") fully visible.
- Detailed token figures (input, output, cache hit, hit percentage, cache
  write) moved into the popover; the bar keeps context used, capacity, and
  percentage always visible.

## 2.2.2

- Added an always-visible conversation context dashboard in the composer: current
  context used versus model capacity, percentage, cumulative input/output tokens,
  cache-hit tokens, cache-hit percentage, and cache writes, sourced from Pi's
  authoritative `get_session_stats` (never from cumulative totals).
- Unknown context estimates after compaction are shown honestly while retaining
  known capacity and totals; no polling — stats refresh on open, assistant
  message completion, compaction, model changes, and run boundaries.
- The model & reasoning control is now compact and sits beside Send/Stop;
  the freed toolbar space carries the dashboard (three-column metrics on
  mobile, single row on desktop) with 320px-safe, reduced-motion, and
  screen-reader support in all 11 languages.
- Session/history wire formats now preserve Pi's full usage components
  (input/output/cacheRead/cacheWrite and nested cost) alongside legacy totals.

## 2.2.1

- Corrected all 11 setup-guide locales to recommend independent `PIHARBOR3`
  credentials and reserve the shared Web token only for legacy manual URL entry.

## 2.2.0

- Added one-time `PIHARBOR3` pairing with independent, revocable per-peer
  credentials, dedicated bearer relay authentication, and legacy shared-token
  fallback for manual and previously saved devices.
- Added local pairing review, sanitized incoming-grant management, atomic trust
  storage, installer/updater archive preflight, pinned CI action revisions,
  keyed device/pairing localization, and synchronized release version tooling.
- Mermaid remains a runtime CDN dependency; release signing is still future work.

## 2.1.2

- Hardened the one-time access-key reveal against DNS rebinding and unexpected
  reverse proxies by requiring both the TCP source and HTTP Host to be loopback.
- Fixed duplicate onboarding element IDs and CSS collisions so both the access
  key flow and the reusable setup guide keep their own labels and Skip actions.
- Replaced unsigned pairing codes with short-lived HMAC-authenticated v2 codes;
  candidate URLs no longer receive a reusable login cookie before trust is proven.
- Corrected the Traditional Chinese access-key wording and added live server
  integration tests for token reveal and credential-safe device pairing.
- Bumped the application and PWA resources to 2.1.2.

## 2.1.1

- Added a hardware-wallet-style first-run onboarding that reveals the private
  access key once on the host computer before sign-in, gated behind two
  confirmations and never shown again after they are saved.
- Restricted the key reveal to loopback requests without forwarding or
  Tailscale headers, and stored the one-time confirmation beside the token
  file with owner-only permissions.
- Bumped the application and PWA resources to 2.1.1.

## 2.1.0

- Added a touch-safe left-edge swipe back from Settings with shared cleanup and
  reduced-motion-safe transitions.
- Fixed the first New project folder load to use the selected host's safe home
  request and ignore stale or non-absolute paths.
- Added localized first-login token guidance, expanded the setup guide for
  devices and LLM providers, and documented token retrieval in every locale.
- Fixed localization collisions that could corrupt words such as “Project” and
  kept user-provided folder names and paths unchanged.
- Bumped the application and PWA resources to 2.1.0.

## 2.0.9

- Added a localized multi-device update center with per-device versions, phases,
  last/next check times, and an Update all devices action.
- Made deferred updates explicit while Agent work is active and applied them
  immediately after the final active RPC settles, with a final updater safety gate.
- Bumped the application and PWA resources to 2.0.9.

## 2.0.8

- Prevented browsers from caching the service worker for 24 hours, which could
  leave an installed mobile PWA displaying the previous Pi Harbor release.
- Rechecked the service worker when the app is opened or returns to the
  foreground, bypassing the HTTP cache for update checks.
- Compared the loaded client with the origin server after a manual update and
  reloaded automatically when a newer application bundle is ready.
- Displayed the selected device's live Pi Harbor version in About instead of
  relying only on the version baked into the original HTML.

## 2.0.7

- Reorganized Settings into clearer Connection, Appearance, Behavior, About,
  and Advanced groups, with updates and version details together under About.
- Reduced session-list clutter by showing the large New project card only when
  empty and using one compact top-bar action once sessions exist.
- Combined model and reasoning selection into one composer control, unified
  live Agent status, and improved long-response typography and touch targets.
- Added a compact device health indicator and lighter, more consistent visual
  treatment across settings cards and controls.
- Requested portrait orientation for the installed mobile PWA, with a
  best-effort Screen Orientation API lock on supported touch devices.

## 2.0.6

- Added one quiet, collapsed task receipt after a tool-using run settles,
  showing only its reliable outcome, edited-file count, and tool count.
- Kept receipts out of ordinary text replies and preserved the existing
  thinking, tool output, usage, and error details behind disclosure.
- Distinguished completed, failed, interrupted, and missing-final-response
  runs without treating intermediate retries or queued continuations as final.
- Localized task receipts across all 11 supported languages.

## 2.0.5

- Replaced the inactive desktop composer with one clear New project action
  until a conversation is opened or created.
- Changed the send control from a paper plane to a minimal upward arrow while
  keeping the separate stop state unchanged.
- Preserved mobile background conversation content when returning to the
  session list, and prevented the inactive composer from flashing on load.

## 2.0.4

- Made first sign-in wait for the authoritative device catalog before loading
  sessions or opening the setup guide, so devices appear immediately without
  closing and reopening Pi Harbor.
- Added bounded retries and a visible retry action for temporary device-list
  failures without retrying expired authentication.
- Kept the selected local or remote device stable while refreshing the catalog,
  with an additional safety refresh when the first-run guide is dismissed.

## 2.0.3

- Gave Pine Milk its own pine-and-cream palette. It previously had no colours
  of its own and fell back to the default theme, so it looked identical to
  Ink & Ivory.
- Kept a saved Pine Milk selection instead of resetting it to the default.
- Drew the in-app brand mark from the theme's text colour with no plate behind
  it, so it reads light on dark themes and dark on light themes.

## 2.0.2

- Kept an automatically updated v1 service on its configured token file, port,
  host, and browse roots by reading the previous environment variable names as
  a fallback. Without this, an updated v1 install started with a throwaway
  token and rejected every sign-in.

## 2.0.1

- Fixed the final legacy-folder migration step in the macOS installer.
- Preserved the local SSH launcher across repeated installations and verified
  that health checks belong to the newly installed release.

## 2.0.0

- Renamed the complete product, runtime paths, service labels, storage keys,
  pairing format, and deployment assets to Pi Harbor.
- Introduced the original Terminal Dock logo and application icon.
- Added a macOS one-click installer and recoverable uninstaller, with optional
  official Pi Agent installation.
- Moved automatic updates to checksum-verified stable GitHub Releases and
  deferred activation while Pi work is running.
- Added a multilingual first-run guide that can be reopened from Settings.
- Preserved existing sessions, providers, projects, and Web token during the
  local v1 migration.
