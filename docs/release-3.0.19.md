# Stepsemble 3.0.19 release record

## Scope

The Sessions page now keeps its primary list clear: the Agent Hub task preview
is collapsed by default and can be expanded on demand, while Claude Code sign-in
is available from Settings → Agent sign-in. The Sub Agent sessions opt-in switch
also lives under Settings → Behavior. The Claude status controller is scoped to
the visible Settings disclosure so a hidden panel cannot continue polling.

## Verification

- Agent Hub disclosure, bounded layout, and auth placement regression coverage;
- Sub Agent preference migration and settings-render coverage;
- JavaScript, version-source, and whitespace checks;
- full Node test suite;
- clean diff before publishing.

## Follow-up

The first 3.0.19 browser run exposed a test-harness assumption that Claude
sign-in was still on the Sessions page. The product move is intentional; the
synthetic browser case now opens Settings before checking the same auth flow.
