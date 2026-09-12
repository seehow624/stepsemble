# Stepsemble 3.0.24 release record

## Scope

Keep Task center activity timestamps readable on narrow screens. Each task row
shows the compact local date/time in the action column; the full translated
“updated” phrase remains available through the tooltip and accessibility label.

## Verification

- full Node test suite;
- `npm run check`, `npm run check:client`, `npm run version:check`, and
  `git diff --check`.
