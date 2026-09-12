# Stepsemble 3.0.23 release record

## Scope

Refine the Agent Hub Task center for dense, mobile-first use. The panel now
behaves as a bounded bottom sheet on small screens and a centered dialog on
larger screens. Its task list scrolls independently from the rest of the
Sessions page, repeated empty-output rows are removed, and Stop actions remain
easy to reach and accessible.

## Verification

- Task center smoke coverage for dialog semantics, search region, bounded
  sheet/list geometry, compact rows, and accessible stop labels;
- full Node test suite: 1,259 passed, 2 skipped, 0 failed;
- `npm run check`, `npm run check:client`, `npm run version:check`, and
  `git diff --check`.

## Follow-up

The 3.0.24 patch keeps the activity column compact by showing the local
date/time directly and moving the full translated update phrase to the tooltip
and accessible label.
