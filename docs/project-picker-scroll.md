# New project nested scrolling (3.0.5)

## Requested interaction

The owner requested a second scrollbar inside the folder picker on 2026-09-06.
Keep the complete New project form scrollable, but do not let hundreds of
subfolders stretch it into a very long page.

- `.project-sheet` remains the outer native scroll container.
- `.project-folder-list` has a responsive `clamp(144px, 32dvh, 320px)` height
  limit and its own native vertical overflow. The limit is not a fixed height;
  an empty or short list can remain shorter.
- Inner overscroll is contained. Scroll outside the list to move the form and
  reach Agent/worktree settings and Start here. No custom wheel/touch handlers.
- The folder region is labelled using the existing translated heading and can
  receive keyboard focus. Opening another directory resets its scroll position.
  Navigation replaces only that lightweight region: native in-flight keyboard
  scrolling on Chromium/Linux can survive setting scrollTop to zero and move
  newly inserted rows. A fresh region discards old momentum, while focus stays
  inside the list only if it was already there; the outer form is preserved.
- The approved logo, native harness launch paths, account configuration and
  session/history storage are unchanged. Versioned assets and the service-worker
  cache move together to 3.0.5.

## Verification

An isolated actual Host serves 200 synthetic folders, 80 children in the first
folder, and empty leaf directories. It uses its own temporary home/token and
never launches a model task. Cleanup removes only this owned fixture.

Codex Computer Use verified desktop 1190x830 and 1440x1000, mobile-sized 390x844,
and short 320x480 layouts. The measured inner heights were 265, 319, 269 and 153
CSS pixels respectively (borders account for rounding against CSS max-height).
Inner wheel/End/Home scrolling left outer scrollTop at zero, even at the inner
bottom edge. Navigating up from a scrolled child directory reset the list to
zero; empty directories rendered correctly. Outer scrolling reached Start here
at every checked size; there was no horizontal overflow or console error.

This is desktop browser viewport verification, not physical iPhone/Safari,
native touch gesture, accessibility audit or performance certification.

The executable regression in `scripts/project-picker-browser-cases.mjs` covers
three viewport sizes and is included in the macOS/Linux rolling-browser CI.
Regular CI also preserves the outer-scroll guard and tests the nested CSS/ARIA
contract. Release publication waits for both exact-commit CI workflows to pass.

The first CI runs exposed a real first-install service-worker issue: activation
broadcasts UPDATED even when its cache version matches the displayed document,
which scheduled a 900 ms reload and discarded the open picker. The client now
ignores only an exact same-version activation. Different/legacy notifications
and active-stream deferral retain their existing behavior. Unit tests execute
the actual message handler; browser cases leave service workers enabled and
verify first activation causes no navigation and preserves the open form.

## Rollout

- Released source `7851c1028d1c9f5f3286478c5912bf283241e218`, tag `v3.0.5`.
  [CI 34022367919](https://github.com/seehow624/stepsemble/actions/runs/34022367919)
  passed on macOS/Windows/Linux: 332 tests each; pass/skip counts 330/2,
  322/10 and 329/3 respectively, no failures. Strict client/artifact/version,
  shell/syntax and 1,251-case independent schema conformance also passed.
- [Rolling 34022367901](https://github.com/seehow624/stepsemble/actions/runs/34022367901)
  passed on macOS/Linux: each has 8 historical client/Host pairings, 2 Claude
  auth UI cases, 2 Pi UI cases and all 3 new nested-picker viewports. Earlier
  failures were resolved, not skipped: same-version reload, native scroll
  momentum, and a welcome-wizard assumption (mobile hides its Skip button).
  Picker fixtures start past that separate wizard; service workers stay enabled.
- [Release 34022474536](https://github.com/seehow624/stepsemble/actions/runs/34022474536)
  published [3.0.5](https://github.com/seehow624/stepsemble/releases/tag/v3.0.5).
  Downloaded source/legacy aliases match, both checksums verify, and the archive
  exactly equals the tested tag's tar stream. SHA-256:
  `a8f1c23ff102301d6cd90ecde7e04cd6291b77b4226d3fb2ce0292a2f0aad686`.
  GitHub attestation verification restricted to this repo's release workflow passed.
- Both production hosts updated through the existing normal updater, after
  fresh zero-RPC/active-task and inactive-Claude-login checks. MacBook Pro
  applied at 08:41:53Z and Mini at 08:42:09Z on 2026-09-06. Both subsequently
  reported healthy 3.0.5, up_to_date, no error/pending update, and stable automatic
  60-minute checks still enabled. No SSH credential workaround or model call.
- Five live assets per host (HTML/CSS/app/service-worker/approved colour icon)
  exactly matched release source; the paired host was checked via its direct
  HTTPS URL as well as authenticated relay health/status. Actual Mini browser
  loaded v3.0.5 and independently scrolled its 20-folder home list (inner 733,
  outer 0), with no console errors. Closing the picker left the session list intact.
- Mini's 17 protected file hashes/absent-file states and all 25 native Pi file
  path/size/mtime records stayed identical. Both independent helper PIDs stayed
  unchanged. Its previous stable 3.0.4 is retained as the normal rollback; rc.3
  was moved to a separate dated backup before this update, preserving older
  rollback copies. Private audit manifests and exact backup paths are recorded
  in the owner's vault, outside this public repository. No claim is made about
  uninspected remote credential hashes or Keychain internals.

Both owned synthetic Host processes/tabs were closed and their temporary
directories removed. Physical-device/Safari/native-touch testing and the broader
platform roadmap remain separate open gates.
