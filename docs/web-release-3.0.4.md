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

- Released source: `4c144ad994ed9e1538c4a0c35655e063eb89152d`, tag `v3.0.4`.
  [CI 34018959542](https://github.com/seehow624/stepsemble/actions/runs/34018959542):
  331 tests per OS, macOS 329 pass / 2 skip; Windows 321 / 10; Linux 328 / 3;
  zero failures. Strict TS, artifacts, syntax, versions and 1,251-case Ajv pass.
  [Rolling 34018995751](https://github.com/seehow624/stepsemble/actions/runs/34018995751):
  macOS/Linux each pass 8 released-client pairings + 2 Claude auth + 2 Pi UI cases.
- Actual Codex Computer Use checks: 390px and 320px mobile, 1440px desktop,
  dark/light and Traditional Chinese settings, 5,000-message synthetic history,
  unsent draft restored after reload, and empty desktop pane after leaving chat
  on mobile. No model messages were sent. An obsolete desktop-only smoke regex
  initially failed CI after the viewport fix; it was corrected without removing
  the new executable behavior regression, and the full matrix reran successfully.
- Mini activated from rc.3 with the existing installer and exact tested source.
  Authenticated preflight had zero RPCs and zero active tasks; Claude login was
  cancelled/signed_out. Production HTTP, existing browser rc.3-to-3.0.4 reload,
  HTTPS tailnet route, approved logo bytes, folder picker, Agent options, version
  and update UI pass. Browser console had no warning/error entries during checks.
- 25 native Pi files retain identical path/size/mtime inventory. All 17 protected
  file hashes (including absent-file state) are unchanged: token, model/settings,
  native auth files, SSH key/known-hosts/launcher and helper/service definitions.
  This is not a proof of unchanged Keychain internals or a native model smoke.
  Claude desktop helper PID 99608 and legacy CUA helper PID 636 stayed running.
- rc.3 is retained as the installer's `.previous`; the former 3.0.3 rollback was
  moved to a separate dated backup before activation. Older backups remain.
  Private before/after manifests and service backups are stored locally, outside
  this public repo; exact locations are in the owner's vault handoff card.
- [Release 34019119879](https://github.com/seehow624/stepsemble/actions/runs/34019119879)
  published [Stepsemble 3.0.4](https://github.com/seehow624/stepsemble/releases/tag/v3.0.4).
  Both downloaded archives have SHA-256
  `eef930b993d6cc09ee3ceacfb27f884f8923add7e2df711bf8611d178097b2f4`;
  checksum verification, identical legacy alias, installer archive safety
  preflight, exact extracted-source comparison and GitHub attestation restricted
  to `seehow624/stepsemble/.github/workflows/release.yml` pass.
- One normal update check after publication reports stable 3.0.4 / up_to_date,
  no pending update/error, automatic 60-minute checks retained; no second restart.

### Remaining paired-host rollout

The MacBook Pro relay is reachable but still reports 3.0.0, zero RPCs/tasks and
`updater.installed=false` / `phase=unavailable`. Read-only SSH with existing
credentials and strict host-key checking was denied. No alternate credential,
agent-execution workaround or forced restart was attempted. Its owner must run
the published installer locally before that host can be marked updated.
