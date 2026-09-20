# Stepsemble 3.0.72 — live model catalog refresh

OpenCode Go's persisted Pi catalog already contained DeepSeek V4.1 Flash and
the renamed GLM-5.3-Flash, but an open Pi RPC returned its startup snapshot.
The composer queried that snapshot directly, while the old refresh route only
updated the file. Session reads could also overwrite the global settings cache.

Model reads now revalidate the configured provider catalogs (five-minute TTL;
explicit check bypasses the TTL), then reload the session registry through a
Stepsemble-owned Pi extension before reading it. The extension is verified via
`get_commands` before invocation, so a missing command cannot become a model
prompt. The active model and history are not replaced. A real installed-Pi
probe reproduces the stale snapshot, refreshes it, selects the new model, and
verifies zero messages and zero inference calls.

The host also checks every five minutes; visible Pi model/settings views refresh
on that interval and when returning to the app. Settings no longer borrow a
session catalog or cache it indefinitely. Catalog failures are visible, including
partial failures; prior data remains usable. Requests share one refresh, use
four workers and an eight-second network deadline. Native store commits use
Pi's own file lock with a per-provider comparison to preserve concurrent writes.

## Source boundaries

- Pi built-in providers use Pi's public catalog service, including previously
  configured providers without a store entry. No API key is sent to that service.
- Automatically discovered local/API provider presets refresh through their
  existing configured discovery endpoint. Renamed/additional/removed models
  replace the discovered snapshot while credentials and reasoning metadata are
  retained. A concurrent user edit is never overwritten.
- Manually edited/imported model lists remain manual. Curated static presets
  without a discovery endpoint cannot claim live freshness. Choosing the normal
  service setup flow re-enables discovery for supported presets.
- OpenCode-native, Claude, Codex and gateway catalogs remain owned by their own
  adapters. Pi provider keys/models are not copied into another harness.
- Upstream publication and host connectivity still determine availability;
  polling is not a guarantee of instant vendor push updates.

## Verification

- `npm run check`, `npm test`: 1,481 passed, 4 skipped, 0 failed.
- `node scripts/check-pi-catalog-refresh.mjs`: real Pi, isolated fixture,
  stale-snapshot reproduction, reload, new model selection, zero inference.
- Regression tests cover additions/removals/renames, 304, failure retention,
  malformed catalogs, request coalescing, TTL/manual checks, offline operation,
  session/global separation, manual presets and concurrent edits.
- Chrome UI against an isolated real-Pi host: settings and the conversation
  picker both show DeepSeek V4.1 Flash and GLM-5.3-Flash without the old multiplier.
  The baseline-only Omen Alpha disappears; DeepSeek V4.1 Flash can be selected
  and becomes the composer model. No inference was sent.
- Pi's baseline/overlay merge is reconciled only when the remote snapshot is
  newer than Pi's bundled data; manual providers and extension endpoints are
  preserved. Model names bypass UI translation (e.g. Qwen Plus stays Plus).
