# Rolling released Client/Host compatibility

`npm run test:rolling` runs actual browser code and actual Node Hosts from the
two immutable releases in `rolling-releases.json`, paired in both directions
with the current development tree. At this pre-release point these are v3.0.3
and v3.0.2, the latest two **shipped** versions before the next release; the
development tree still retains the 3.0.3 package version. Tags are verified against
full commit IDs, then Git archives are extracted into disposable local folders.
Nothing is checked out over the worktree. Update the pins explicitly at release
time; do not float tags or substitute current sources for a historical Client.

Verified clean commit `43379f474e0bd17c5983542683b71060a76749e1` passed all eight
cases on each of macOS and Linux (16 total), Chromium 153.0.8010.12, in
[run 33970245044](https://github.com/seehow624/stepsemble/actions/runs/33970245044).
Its separate three-OS, 267-test general suite completed with zero failures in
[run 33970245094](https://github.com/seehow624/stepsemble/actions/runs/33970245094).
Later source changes require their own passing run; this evidence is not floating.

## What is exercised

There are eight cases: two release versions × two directions × desktop
1440×1000 and mobile-sized 390×844 viewports. Each starts a fresh loopback Host,
isolated HOME/PI_HOME/config/project/history, a fresh Chromium context and an
entirely synthetic Pi protocol process. It exercises the real login form,
session list, Unicode history, streamed text, manual stop, a permission dialog
answered by cancellation, and page reload with cookie authentication/history.
The synthetic peer counts exactly two prompts, one stop and one denied response.
The browser must issue one UI response, not duplicate the side effect.

Current Client → historical Host observes an actual 404 from the absent protocol
handshake endpoint and follows the legacy path. Historical Clients never send a
handshake they do not implement. Separate `platform-protocol.test.js` tests ensure
401, 426, malformed responses, failures and timeout do not silently downgrade.
This does not imply that a released Client understands the reserved journal API.

The browser receives **all** static assets from the selected Client tree while
API/SSE traffic reaches the selected real Host. External browser HTTP requests
are rejected. Runtime errors fail the case. Output contains only commit/version,
viewport/browser, assertion results and synthetic effect counts—not login keys,
prompts from real sessions, native credentials or private paths. A dirty local
tree is labeled explicitly; only clean CI results identify an exact source commit.

## Isolation and provenance

Playwright 1.63.0 is a test-only, public-registry/SHA-512-locked dependency. npm
uses empty config files, scripts disabled and local-temp dependency/cache paths.
The pinned runner downloads its matching Chromium headless shell from the
Playwright distribution; npm integrity hashes cover npm packages, not that
browser archive. The browser version is recorded per case. Browser profiles,
historical sources, Host data and owned children are removed on completion/failure.
No existing browser profile, installed Pi, agent account or production service is
used. No runtime dependency or build output is installed onto the project volume.

The separate `Rolling browser compatibility` workflow runs macOS 14 arm64 and
Ubuntu 24.04 x64. Historical Host launch code is Unix-based, so Windows is not
claimed here. The current Host's general/native Pi tests have their own actual
Windows matrix. Updating the test-only npm lock requires the explicit command
`npm run test:rolling -- --update-lock` and a reviewed diff; regular runs use `ci`.

## Deliberate limits

This is a **legacy Web rolling smoke gate**, not the complete platform release
gate. Service workers are blocked so they cannot replace the selected Client
assets; cached PWA upgrades, offline app-shell behavior and cache migration need
separate tests. A viewport is not an iPhone/Android physical-device test. This
does not measure INP/TBT, native models/tools/subscriptions, native restart
durability, all UI actions, Safari/Firefox, or the future journal/snapshot API.
Do not interpret passed synthetic cancellation as a real native tool approval
ACK. The isolated peer is labeled synthetic and contains no real execution.
