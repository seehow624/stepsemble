# Stepsemble 3.0.18 release record

## Scope

Active Agent Hub tasks now stay inside a bounded live preview. When a task is
starting, running, or reconnecting, the card receives an explicit compact
height and its task rows own the inner vertical scroll surface. The Sessions
heading and the main conversation list therefore remain reachable while live
rows are inserted or updated asynchronously.

## Verification

- Agent Hub active-task layout regression coverage in the smoke suite;
- JavaScript and session syntax checks;
- full Node test suite;
- clean diff and version-source verification before publishing.
