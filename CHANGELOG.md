# Changelog

## 3.0.5

- Bound the New project folder list to its own scroll area while preserving
  the outer form scrollbar and access to Agent settings and Start here.
- Add a labelled, keyboard-focusable folder region, native touch scrolling,
  a stable scrollbar gutter and scroll-position reset when opening a folder.
- Exercise 200 folders, nested wheel/keyboard scrolling, empty folders and
  reachable bottom controls at desktop, mobile and short-screen sizes in CI.
- Do not reload and discard an open form when the offline cache activates for
  the same version already displayed by the browser.

## 3.0.4

- Display the approved full-colour Step Mosaic on the workspace, sign-in,
  onboarding and empty conversation, without redrawing the source artwork.
- Separate the workspace identity from the host selector, label New project,
  wrap all Agent chips on narrow screens, and enlarge key touch targets.
- Fix Pi idle shutdown being reported as Failed, unify native session titles,
  and protect work starting concurrently with session closure.
- Fence Agent Hub responses by host and request identity; do not turn failed
  discovery into a fabricated installed-agent status.
- Precache the colour logo and limit service-worker cleanup to known app shells.
- Clear closed-chat content at every viewport size, so widening a mobile list
  cannot reveal a stale conversation in the desktop pane.
- Include the previously tested protocol, dialog recovery, bounded streaming,
  recoverable archive and opt-in Claude desktop-helper work from the rc series.
- Publish under Apache-2.0 with preserved legacy and third-party notices.
- Other CLI agents remain terminal integrations, not full native history or
  structured approval parity. Rust, native Apps, physical-device and long-soak
  gates remain on the roadmap.

## 3.0.4-rc.4

Development candidate; not activated or published as a stable release.

- Prevented intentional idle Pi SIGTERM/143 shutdowns from appearing as Failed;
  genuine crashes, active interruption and observed model failures stay visible.
- Protected prompt preflight, pending dialogs/commands, streaming and compaction
  from stale close requests; fenced sends/reuse after close intent and concurrent
  metadata opens before spawning another writer.
- Unified Pi titles across lists, Agent Hub, chat, search and export: latest
  native name (including resets), then first user text; never the JSONL filename
  or latest assistant answer on the new Host. Native history is not migrated.
- Added isolated lifecycle/race and desktop/mobile browser regressions, plus a
  separate PWA cache identity. Not deployed or published as a stable release.

## 3.0.4-rc.3

- Added an opt-in macOS Aqua desktop Claude broker for both official sign-in
  and task supervisor launch. The SSH Web Host is preserved; no credential
  copying, shell/env injection or fallback to SSH when the helper is absent.
- Added owner-only IPC, single-use launch tickets, bounded admission and
  persistent uncertain-operation guards. Existing terminal tasks can reconnect
  after Web/helper restarts without repeating their launch.
- Added a real macOS GUI-context offline fixture and explicit helper installer.
  Native metadata was detected through SSH-to-desktop IPC on the trial host;
  this is not a successful model/login or complete native history/approval test.

## 3.0.4-rc.2

- Prevented known macOS SSH hosts from treating desktop Claude authentication
  as signed out or launching another login. These hosts require a desktop
  execution helper; the main SSH service remains unchanged.
- The local rc.1 trial was rolled back to 3.0.3 after the real authentication
  context check failed. This candidate is not deployed or a stable release.

## 3.0.4-rc.1

- Added the guarded Claude Code sign-in entry in Agent Hub. The installed
  official CLI opens the Host browser; Stepsemble does not relay OAuth material.
- Includes the unreleased reliability, protocol, native Pi dialog and browser
  recovery work documented in `docs/platform-plan.md` 1.24. Reference protocol
  planners are not a completed durable store or full native-agent parity.
- Assigned separate asset queries and a service-worker cache for the trial.
  No stable GitHub release or automatic rollout to other devices is implied.

## 3.0.3

- Made the exact user-approved 1254 px Step Mosaic artwork the canonical brand
  source instead of continuing with an approximate hand-redrawn SVG.
- Regenerated the Apple touch and PWA icons directly from that source, and
  derived the monochrome interface mask from the same silhouette.
- Removed the inaccurate coloured SVG redraws from active use and locked the
  canonical source checksum in the brand regression test.

## 3.0.2

- Corrected the Step Mosaic vector construction so every violet coordination
  inset overlaps and remains visibly attached to its ivory agent module,
  including at small icon sizes.

## 3.0.1

- Replaced the literal cat-paw-and-terminal mark with a vendor-neutral Step
  Mosaic: four equal agent modules move in one rhythm, and each reveals the
  same violet Stepsemble coordination layer.
- Added matched full-colour app, rounded logo, monochrome mask, Apple touch,
  and maskable PWA artwork without assigning any provider a privileged brand
  colour.

## 3.0.0

- Renamed Pi Harbor to Stepsemble, with a new cat-paw-and-terminal identity
  for a workspace that coordinates multiple coding agents.
- Preserved existing Pi Harbor and Pi Web state through an additive migration:
  private configuration, tokens, device trust, task journals, browser
  preferences, cookies, environment variables, and pairing codes remain
  readable while all new writes use Stepsemble names.
- Added upgrade-aware macOS, Linux, and Windows installation paths so the
  public rename does not move Pi sessions, provider credentials, approvals,
  or project files.
- Bumped the pairing protocol emitted by new hosts to `STEPSEMBLE3` while
  accepting `PIHARBOR3` and the token-authenticated `PIHARBOR2` transition
  format.

## 2.13.2

- Fixed empty usage dates inheriting the global empty-state padding, which
  stretched the About card into large gaps on mobile.

## 2.13.1

- Fixed the Settings → About usage card leaking the `usage.title` key and
  stretching empty days into large gaps on narrow screens.
- Usage rows now use intrinsic compact tracks, and the renderer repairs the
  heading/list semantics when an older PWA shell reconnects.
- Service-worker shell installs and navigations now bypass HTTP-cached HTML so
  releases cannot reopen with stale layout or localization resources.

## 2.13.0

- Generic Agent Hub tasks now run under an independent per-task supervisor,
  reconnect after a Pi Harbor service restart, preserve elapsed time/output,
  and are marked interrupted when the supervisor is truly gone.
- Added a searchable Agent Hub task center with status filters, replay, native
  Pi stop controls, automatic reopen of the last generic task, and push
  notifications for unattended Agent completions.
- Added a versioned connector manifest/event contract, Linux systemd and
  Windows Scheduled Task installers, cross-platform CI, and updater health
  checks with automatic macOS rollback when a release fails to start.
- Settings wheel gestures now forward from the fixed toolbar/overlay edges,
  while language choices keep their local names (English, 简体中文, 繁體中文,
  and more).

## 2.12.1

- Agent discovery now checks the common Homebrew, user-bin, npm, Volta,
  asdf, Bun, and Hermes paths in addition to launchd's PATH. Installed Codex,
  Claude Code, and OpenCode CLIs therefore remain selectable when Pi Harbor is
  started as a background service.

## 2.12.0

- Added Agent Hub connectors for the native Pi Agent plus installed Claude
  Code, Codex CLI, Grok Build, and OpenCode executables. Connector ids are
  allow-listed, project paths are validated server-side, and arbitrary shell
  commands are never accepted from the browser.
- Added a streamed task inbox with per-task elapsed time, reconnectable SSE,
  bounded private output journals, isolated Git worktrees, and background
  execution after leaving or closing the browser.
- Added a dependency-free Unix PTY bridge for interactive CLIs (with a safe
  pipe fallback on Windows or hosts without Python), plus truthful detached /
  orphaned states after a supervised restart.
- Added localized Agent Hub labels and a one-second local clock that updates
  without rebuilding the task list, preserving scroll position and focus.

## 2.11.2

- Automatic updates and fresh installs now fall back to the public GitHub
  release page when the unauthenticated GitHub API rate limit is exhausted.
  The archive and SHA-256 checksum are still downloaded and verified before
  activation.

## 2.11.1

- macOS devices now use the system ComputerName as the default Pi Harbor
  label, while retaining the network hostname for connectivity. A hostname
  such as `Mac.lan` no longer replaces a friendly device name in the UI.

## 2.11.0

- Archiving is now reversible. Session archive, project archive, and project
  removal skip the blocking confirm and show a toast with a 7-second Undo
  button; the server gained a validated unarchive action that moves the
  snapshot back to its original location. Flows touching credentials or
  irreversible steps keep their confirms.
- Fixed during development of this release (never shipped): the unarchive
  path initially required the destination file to exist and then deleted the
  snapshot regardless, which would have destroyed the archived session. It now
  validates destinations without requiring existence and only removes the
  snapshot when every captured file returned home.
- Keyboard shortcuts on the list: / focuses search, n opens the new-project
  dialog, arrow keys walk the rows. All are suppressed while typing, while the
  palette, setup guide, or any dialog is open.
- The command palette gains "Settings → Devices / Access tokens / Connection /
  Appearance / About" jump targets and live filtering while typing (it only
  re-rendered on open and Enter before), and session/device names no longer
  run through the phrase translator, which was mangling them.

## 2.10.0

- Reloading Pi Harbor now returns to the conversation the user had open
  instead of the session list, including a run that is still in flight: the
  chat reattaches to the live process and the elapsed timer continues. The
  last chat is remembered per device.
- Sidebar rows lead with a compact recency stamp (Just now / 5m / 2h / 3d), so
  scanning for recent work no longer relies on sort order.
- The running-state poll no longer rebuilds the whole sidebar every five
  seconds. It now polls the cheap /api/rpcs endpoint and redraws only when the
  visible running set actually changes (a run started, settled, or flipped its
  stuck flag); elapsed-time text keeps ticking via the existing 1s updater.

## 2.9.0

- Closing and reopening Pi Harbor mid-run now shows what is still working. The
  session list marks a running conversation with a pulsing dot and its elapsed
  time ("Running for 27s"), so the first screen after reopening answers whether
  the host is still busy instead of looking idle.
- The elapsed time comes from the run on the server, so it is the real duration
  after a reload or from another device, and it keeps ticking while the list is
  open. The badge clears itself when the run settles.
- The list refreshes every five seconds only while it is visible and something
  is actually running; an idle app makes no extra requests.

## 2.8.1

- Fixed broken English (and every other non-Chinese locale) in runtime
  messages. Around 65 user-facing strings were authored as Chinese sentences
  and translated by phrase substitution, which produced output such as
  "Connection，workStill …" for a restored connection and "Enabled：" when a
  conversation failed to open. They are stable translation keys now, so
  connection, retry, compaction, provider setup, and device management all
  read as real sentences in all 11 locales. A test fails the build if a new
  hardcoded sentence appears.

## 2.8.0

- The chat header now shows how long the current turn has been working, next
  to the Thinking/Working status. It ticks every second while the run is live
  and keeps the final duration once the answer arrives, so a long run is
  visibly progressing instead of looking frozen. Format is seconds, then m:ss,
  then h:mm:ss, in tabular digits so the header does not shift on each tick.
- The elapsed time belongs to the run, not the browser tab: the server records
  when the turn started and hands it back on reconnect, so reloading the page
  or opening the session on another device continues the same clock instead of
  restarting at zero.

## 2.7.1

- A supervised server no longer outlives the process that started it. A script
  that spawned Pi Harbor and then failed before its own cleanup left the server
  holding a port and an open stdio pipe, which kept the caller's event loop
  alive: both sides waited for each other and the calling Agent run appeared
  frozen with no output for hours. The server now notices that it has been
  re-parented and stops through the normal drain path, so the caller fails fast
  instead of hanging. Set `PI_HARBOR_ORPHAN_EXIT=0` to opt out; launchd and the
  SSH launcher are unaffected.

## 2.7.0

- Provider config portability: export the whole models.json provider list to
  a JSON file (secrets strictly opt-in with a plain warning) and import it on
  another device; every imported provider passes the same validation as the
  editor, and same-id providers are replaced explicitly.
- Full-text session search: sidebar queries of two or more characters now
  also search inside recent session transcripts (bounded scan, snippets),
  with results that jump straight into the matching conversation.
- Local usage summary: Settings → About shows the last seven days of tokens
  and cost aggregated from local session files only — no third-party APIs.
- PWA push notifications: opt in from Settings → About; the host sends a
  signed Web Push (VAPID + aes128gcm, implemented with node:crypto only)
  when a run settles with no browser attached, and tapping it opens the app.
- Session action sheet gained "Export as Markdown": user/assistant turns,
  collapsed thinking blocks, tool-call summaries, and provider errors.

## 2.6.0

- Wedged pi runs no longer block auto-updates forever. A run streaming with
  no browser attached and no events for 15 minutes is treated as stuck: the
  updater may apply pending releases while it exists, and the sidebar shows
  a quiet amber banner with a one-tap Force stop.
- The model picker gained a search field and a per-row thinking badge
  (max / xhigh / high) computed from the model's own capability map, so it
  is obvious which models keep `max` before switching.
- Added a command palette (Cmd/Ctrl+K on desktop): jump to recent sessions,
  switch model or device, start a new session, toggle Sub Agent sessions, or
  open Settings without leaving the keyboard. Arrow keys and Enter navigate,
  and Escape closes it like any other dialog.

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
