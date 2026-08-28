# Changelog

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
