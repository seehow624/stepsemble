# Stepsemble 3.0.14 release record

## Scope

This patch fixes the update gate after OpenCode native history is enabled.
Historical OpenCode sessions remain reopenable in Agent Hub and are projected
as `waiting`, but the updater now checks their upstream `isRunning` evidence so
idle history cannot block a verified release forever.

## Verification

- full Node test suite and protocol/client checks;
- macOS, Linux, and Windows CI;
- native history reader boundary and rolling browser workflows;
- live Mac mini OpenCode adapter remains `ready` with approval enabled.
