# Stepsemble 3.0.25 release record

## Scope

Connect the official Codex app-server v2 to Agent Hub as an explicit, read-only
native history source. Codex threads now appear in the task/session projections
when `STEPSEMBLE_CODEX_NATIVE=1` is configured, and the conversation view hydrates
metadata plus bounded turn/item pages instead of requesting a potentially huge
single `thread/read(includeTurns=true)` frame.

The adapter omits private rollout paths from browser DTOs, keeps Codex approval
and mutations unavailable, retires a broken native process for bounded retry, and
falls back to the existing canonical-bounded CLI connector when the opt-in probe
is not ready.

## Verification

- real Codex `0.153.4` app-server probe: ready, 3 threads, metadata-only read,
  20-turn and 50-item bounded pages, no private path exposed;
- full Node suite: 1,265 passed, 2 skipped, 0 failed;
- `npm run check`, `npm run check:client`, `npm run version:check`, and
  `git diff --check`.
