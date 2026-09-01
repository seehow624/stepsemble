# Changelog

## 2.5.5

- The mobile model chip is wider still (200px, 140px on very narrow screens)
  and may shrink gracefully when space runs out, so long model names stay
  readable without pushing the send button off the toolbar.

## 2.5.4

- The composer's model chip is wider on every screen size (240px desktop,
  150px mobile, 124px on very narrow screens), so long entries such as
  "GLM-5.3-Flash (2x usage) · max" stay readable instead of truncating early.

## 2.5.3

- Desktop project rows now reveal the same compact segmented capsule as
  mobile: 32px buttons with 15px icons in a solid hairline capsule with a
  matching collapse chevron, replacing the oversized ghost icons that
  appeared on hover.
- Collapsed project and pinned groups keep a small gap (6px, 4px in compact
  mode) between cards so fully collapsed lists no longer read as overlapping
  borders.

## 2.5.2

- Sidebar geometry: project cards inside the session list now keep the exact
  width of the search box and the Sub Agent filter above them. The list
  reserved a scrollbar gutter (and classic scrollbars narrowed it further),
  which made every project card visibly shorter than the fixed rows on
  desktop while mobile was unaffected. The sidebar scrollbar is now hidden;
  touch and wheel scrolling are unchanged.
- The mobile project row's "+" and "…" actions were redesigned into a
  compact segmented capsule with a matching 32px collapse chevron, replacing
  the oversized floating ghost icons.

## 2.5.1

- Fixed Ollama model thinking metadata. Ollama's `/api/tags` list does not
  include thinking capability; provider setup now checks `/api/show` and
  records the model's `reasoning` flag and supported thinking levels. Ollama
  models that support it now expose `max`, while GPT-OSS correctly exposes
  only `low`, `medium`, and `high` because Ollama cannot fully disable or
  raise its thinking level beyond those values.

## 2.5.0

- The session sidebar now keeps itself up to date. A brand-new session
  appears as soon as its first message is persisted, and settled runs refresh
  the list, so sub agent sessions and previews no longer wait for a manual
  reload.
- The Sub Agent filter row in the sidebar was reworked: a short constant
  label with a state note ("Hidden by default" / "Showing") and a bare count
  replace the long bilingual strings, and the card now shares the session
  rows' inset, radius, and height so it lines up with the project cards.
- Fixed thinking levels silently resetting to off. Pi clamps the thinking
  level to what the selected model supports, and models added through the
  provider editor were saved without the reasoning flag — so every level was
  clamped to off. The provider form now carries a thinking marker per model
  and preserves model fields across edits, the composer re-reads the clamped
  level instead of trusting the request, remembers your last choice, and
  restores it when a session or model switch drops it. Existing ollama-cloud
  GLM/Kimi/MiniMax entries on hosts upgraded from earlier releases keep the
  reasoning flag the editor used to drop.
- Added read-only resource sync in Settings. Pick any two devices to compare
  the global Pi extensions, skills, and installed packages on each host, with
  identical entries collapsed and differences highlighted. The inventory is
  scan-only (no secrets, no symlink escapes) and installs nothing.

## 2.4.5

- The model picker now matches the selected model on provider + id instead of
  id alone. The same model id can be offered by several providers (e.g.
  glm-5.3-flash on both Ollama Cloud and OpenCode Go, or GPT 5.6 Luna on both
  OpenAI Codex and OpenCode Go); picking it used to tick every provider's row
  at once. The checkmark and highlight now land only on the provider that was
  actually selected, with a safe id-only fallback when provider info is
  missing.

## 2.4.4

- Added a live task-progress panel above the composer. Pi plan/todo widgets and
  plan text now appear as a compact Running indicator with an expandable,
  clickable checklist; completed steps remain visible in session history.

## 2.4.3

- The sign-in screen now explains how to read the Web token on macOS, Linux,
  and Windows. The host's own platform is preselected, PowerShell and Command
  Prompt each get their correct syntax, and the commands are never rewritten by
  the locale layer. The README carries the same per-OS commands.

## 2.4.2

- Settings now scrolls from anywhere on the page. The desktop scroller spans
  the full window and centres its cards with padding, so the wheel no longer
  stops working when the pointer sits beside the content column.
- The language picker lists every language in its own language (English,
  简体中文, 繁體中文, 日本語, …) instead of English names, and takes its labels
  from the same locale registry the setup guide already used.
- Escape now closes overlays everywhere: the setup guide, device and pairing
  dialogs, provider setup, new-project and rename dialogs, action sheets, the
  model picker, the image viewer, and inline access-token forms. It closes
  only the topmost layer, then leaves Model settings and Settings in turn.

## 2.4.1

- Fixed a localization feedback loop introduced by the new access-token
  controls. Keyed `title`, `aria-label`, and `placeholder` attributes are now
  rewritten only when their translated value changes, so opening Pi Harbor no
  longer pins the browser renderer at 100% CPU.

## 2.4.0

- Vendored Mermaid 11.12.1 and load it lazily from the Pi Harbor host, so
  diagram sources stay private and Mermaid rendering works offline. The CSP
  no longer permits jsdelivr; upstream license notices are included beside
  the bundle.
- Added optional independent browser access tokens in Settings → Access
  tokens. The installer/master token can issue labelled tokens, each is shown
  only once and can be revoked independently, and the server stores only
  SHA-256 hashes in a 0600 token store. Issued tokens retain the existing
  single-user host access model; they are not separate Pi accounts.
- Release workflows now publish GitHub OIDC artifact attestations for the
  archive and checksum in addition to the existing SHA-256 verification;
  no long-lived signing private key is stored in the repository.

## 2.3.4

- Removed the provider-account quota feature entirely (per feedback): the
  popover again focuses on the conversation's own usage — context, input,
  output, cache hit percentage, and cache write — with the ring trigger and
  all 2.3.x layout refinements kept. Third-party balance APIs varied too
  much in reliability and semantics to be worth the maintenance.

## 2.3.3

- OpenCode Go quota headers are scoped to the calling model's bucket, so the
  probe previously reported an unused model's empty bucket (0% used) instead
  of the subscriber's real usage. The probe now walks the GLM family first
  (glm-5.3, glm-5.2, glm-5.1) followed by configured and documented models,
  preferring the first bucket with non-zero usage and logging every raw
  bucket for diagnosis.

## 2.3.2

- MiniMax coding-plan quota requires web-session authentication: the endpoint
  answers "cookie is missing" to API-key auth. The popover now reports this
  state honestly, and a session cookie can be provided per provider in
  `~/.config/pi-harbor/provider-cookies.json` (mode 0600); cookies are sent
  only back to their own provider and never logged.
- The OpenCode Go probe now tries the models actually configured for that
  provider before the documented defaults, because quota headers are scoped
  to the calling model's bucket.

## 2.3.1

- Simplified provider-account rows: usage windows are labelled just
  "5-hour quota", "Weekly quota", "Monthly quota" under the provider name
  instead of repeating the provider prefix.
- Fixed credential-store region mapping for MiniMax: preset id `minimax` is
  the international endpoint (api.minimax.io) and `minimax-cn` the Chinese
  one, so auth-stored MiniMax keys no longer query the wrong region.
- Added bounded parse-failure diagnostics for provider quota lookups and raw
  OpenCode Go quota header values in the server log to make remote
  troubleshooting possible without exposing credentials.

## 2.3.0

- MiniMax quota lookups now distinguish an invalid or non-coding-plan key
  ("sign in again") from a missing API, and automatically retry the
  provider's other region (China/global) before giving up; Zhipu GLM quota
  lookups gained the same region fallback.
- The OpenCode Go quota probe walks the cost-ranked documented model list
  until quota response headers appear instead of relying on a single model
  name, and logs one bounded diagnostic line when every probe fails.

## 2.2.9

- Provider quotas now cover subscription account logins, not just API keys:
  the snapshot merges models.json with Pi's credential store, so every
  configured provider appears in the popover.
- OpenAI Codex (ChatGPT) shows the 5-hour and weekly usage windows from the
  same backend endpoint the Codex CLI and pi-usage extension consume, using
  the stored OAuth token and its embedded account id.
- OpenCode Go quotas are read from the quota response headers of a minimal
  probe request against the cheapest documented Go model (one probe per
  cache window), mirroring the community approach.
- Subscription providers without any queryable endpoint are labelled
  honestly instead of being omitted.

## 2.2.8

- Extended provider quotas to subscription coding plans, following the same
  community endpoints used by cc-switch and GLM Monitor: Zhipu GLM Coding
  Plan (open.bigmodel.cn / api.z.ai `usage/quota/limit`) shows the 5-hour and
  weekly token windows with reset times plus MCP monthly calls, and MiniMax
  (`coding_plan/remains`) shows remaining call counts. Plan auth follows each
  provider's convention (raw key for Zhipu, Bearer for MiniMax).
- Quota responses now distinguish an invalid key ("sign in again") from a
  provider without any quota API.

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
