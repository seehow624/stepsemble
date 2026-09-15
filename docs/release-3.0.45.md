# Stepsemble 3.0.45 deployment follow-up

The 3.0.44 real-host rollout found issues that local mocks did not expose.
This patch keeps the 3.0.44 composer functionality and fixes the service edges.

## Evidence and changes

- MacBook Pro successfully installed 3.0.44, enabling the native adapters,
  but Codex's version probe exited 127. A local env-node CLI wrapper reproduced
  that failure under a sparse service PATH. Installed defaults now append the
  running Node executable's directory only when PATH cannot resolve `node`.
  Existing PATH entries and precedence are retained; a working PATH is untouched.
- Mac mini remained on 3.0.43 because its updater saw an unloaded persisted
  Claude conversation as `waiting`, although `isRunning=false`, `needsLoad=true`
  and native state was `available`. The task projection now labels it history.
- Installer rolling guards recognize that exact older-host state. Missing,
  contradictory or incorrectly typed fields still block the update. Pending
  approvals, actual prompts, interrupting and unknown live states stay active.
- The same tested rolling guard was bootstrapped into the Mini's installed
  updater to let an ordinary update cross the old incorrect state. No forced
  update, task stop, history deletion or credential change was used.

## Validation

- Local suite: 1,358 passed, 4 skipped, 0 failed.
- New tests reproduce env-node exit 127 and successful startup after repair;
  they cover live/idle/stored Claude projections and strict rolling guards.
- Native image/model/context evidence and remaining authentication/device
  boundaries are recorded in [3.0.44 validation](release-3.0.44.md).

Successful application installation is not authentication. Both Claude
credential helpers still reported signed out during rollout. MBP OpenCode
also has no configured native local server; installing its CLI alone does
not create one. These must not be presented as verified native conversations.
