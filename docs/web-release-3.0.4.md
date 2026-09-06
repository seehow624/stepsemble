# Web release 3.0.4

## Scope and authority

On 2026-09-06 the owner asked to ship the previously agreed Web improvements,
including the approved logo, and continue improving stability and usability.
This supersedes the earlier rc.4 activation question: a safe, reversible Web
deployment and public release are now in scope. Do not interrupt running work,
change official credentials/routes, spend model quota, or claim the long-term
native-client roadmap is finished.

## Changes

- Colour Step Mosaic in the persistent workspace header, login, onboarding and
  empty chat. The original master and both resized icons retain their exact
  approved bytes. The monochrome glyph remains for forced-colour accessibility
  and notification badges only; no image regeneration or approximation.
- A dedicated host-selector row and labelled New project action. Agent chips
  wrap instead of clipping horizontally; primary list controls and task rows
  have at least 44 CSS-pixel targets. Explicit search/creation labels, keyboard
  focus rings and reduced-motion/transparency support.
- Catalog/task responses are fenced by request identity and selected host.
  Old finally/catch handlers cannot overwrite a new host or clear its request.
  Host changes/sign-out clear the previous private task snapshot and timers.
  Only a legacy endpoint 404 admits Pi-only fallback; other discovery failures
  are shown as unknown and block project launch until refreshed.
- Colour-logo precaching; activation deletes only known legacy app shell caches,
  not arbitrary caches belonging to other origin features.
- Includes rc.4 Pi title/close fixes and earlier tested rc-series reliability,
  protocol, native-dialog and opt-in Claude desktop-helper work. Apache-2.0 with
  preserved legacy and vendored notices.

## Verification and deployment gates

1. Local syntax, strict TS/artifact/version, schema conformance and full tests.
2. Actual Codex Computer Use inspection on isolated synthetic data: mobile and
   desktop layout, long-history opening, draft preservation, project picker,
   settings, no horizontal overflow and console errors. Viewport emulation is
   not physical iPhone/Safari certification or a performance measurement.
3. Exact commit CI on all three OSes and the existing released-client rolling
   browser matrix. Local test passes are not a substitute for these runs.
4. Before activation, authenticated RPC/task and Claude-operation checks; back up
   service definitions and preserve all existing application rollback copies.
   Record native session inventory and hashes of protected config/brand files.
5. Preserve the installed SSH launcher and independent desktop/CUA helpers.
   Install an exact tested source/archive, then verify matching version health,
   HTTP static bytes, actual browser UI, protected-file hashes and inventory.
6. Publish the verified stable archive/checksum/attestation. Verify the public
   download and updater path, not merely a Git commit or tag.

## Remaining product gates

Other harnesses still provide terminal integration with a bounded output tail,
not Pi-equivalent full native history, structured approvals or session resume.
Durable journal/outbox integration, native proof, Rust migration, Tauri/mobile
Apps, real-device/sleep/resume, multi-browser and 72-hour soak gates remain open
in the accepted platform plan. Official Claude signed-out metadata must remain
visible; it does not authorize login, token repair or a billable fallback.

## Rollout record

- Source prepared as 3.0.4; production activation and public-release outcomes
  are recorded only after the corresponding gates actually pass.
