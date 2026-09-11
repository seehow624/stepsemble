# Stepsemble 3.0.11 release record

This is the cross-platform CI stability hotfix for 3.0.10.

## Fixes

- The isolated eight-task soak now waits through the bounded supervisor
  reconnect window after a Host restart, retrying only explicit transient
  `reconnecting`／`input is unavailable` responses. Terminal or unknown 409
  responses still fail immediately and remain in the evidence report.
- The access-token integration test asks the kernel for a loopback port instead
  of selecting a random fixed range that can overlap Windows reserved ports.
- The 3.0.10 Windows journal ACL/readiness fallback and capability boundary are
  unchanged.

## Verification

Local Node 22 verification:

- Full suite: 1246 passed, 2 platform skips, 0 failed.
- Focused soak and access-token tests: 6 passed, 0 failed.
- `npm run check`, protocol/client checks, version check, shell syntax, and
  `git diff --check` passed.
- Protocol conformance: 1251 cases passed.

The final three-OS CI and release workflow for the tagged commit are the
cross-platform release authority.
