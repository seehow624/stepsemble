# Stepsemble 3.0.13 release record

## Scope

This patch release fixes the macOS SSH launcher path for the OpenCode native
server. When the Mac mini already runs OpenCode as the owner-only
`com.jerome.opencode-web` launchd service, the Stepsemble child now receives
the loopback endpoint and the existing local Basic Auth configuration. Other
launch modes remain explicit and do not scan ports or copy provider state.

## Verification

- `zsh -n deploy/stepsemble-mini-start.sh`
- live Stepsemble `/api/opencode/native` reports `ready`, `native_api`, and
  OpenCode `1.18.5` after launcher restart;
- `/api/agents` reports the OpenCode connector as installed and native;
- the full Node suite and cross-platform CI remain required before tagging.
