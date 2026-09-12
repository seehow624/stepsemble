# Stepsemble 3.0.20 release record

## Scope

Align the rolling browser compatibility harness with the 3.0.19 UI change:
Claude Code sign-in is opened from Settings → Agent sign-in, including after a
reload. No product behavior or authentication contract changes in this patch.

## Verification

- synthetic Claude auth browser coverage opens the Settings view explicitly;
- full Node test suite and JavaScript checks;
- rolling browser compatibility against the released client/Host matrix.
