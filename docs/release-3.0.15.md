# Stepsemble 3.0.15 release record

## Scope

This patch makes the cross-agent conversation view resilient to asynchronous
discovery and keeps the Agent Hub preview from consuming the Sessions list.
Native OpenCode rows remain available in the complete conversation catalog,
while the compact Agent Hub shows only the most relevant live preview.

## Verification

- Agent Hub race tests and conversation catalog tests;
- full smoke suite;
- macOS, Linux, and Windows CI;
- live Mac mini OpenCode adapter remains ready with native sessions available.
