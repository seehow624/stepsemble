# Stepsemble 3.0.17 release record

## Scope

Agent Hub is now a bounded flex panel. A large connector inventory, expanded
Claude sign-in panel, or dense task preview cannot push the main Sessions list
out of its viewport. Connectors scroll horizontally and task rows scroll
vertically inside the panel; the Sessions heading remains fixed and the list
retains its own scroll surface.

## Verification

- Agent Hub layout regression coverage in the smoke suite;
- JavaScript and session syntax checks;
- full Node test suite;
- clean diff and version-source verification before publishing.
