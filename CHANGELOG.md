# Changelog

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
