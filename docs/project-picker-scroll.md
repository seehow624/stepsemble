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

Pending the new browser regression gate. Do not treat the source commit as an
installed update. Both production hosts were healthy on 3.0.4 with stable,
60-minute automatic updating enabled and zero RPCs/tasks during preflight.
