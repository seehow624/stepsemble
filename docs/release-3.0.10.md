# Stepsemble 3.0.10 release record

This is the Windows durability and startup-fallback hotfix for 3.0.9.

## Fixes

- Windows journal ACL setup now uses explicit `SystemRoot` executables,
  typed .NET ACL constructors, and inheritable owner rules for the journal
  directory. SQLite `-wal`/`-shm` siblings therefore stay within the same
  owner boundary.
- A worker that cannot pass its owner/ACL/SQLite readiness gate now becomes
  `journal_unavailable`; generic tasks continue with bounded snapshots and the
  catalog removes durable capabilities. A local security preflight failure no
  longer prevents every CLI task from starting.
- The 3.0.9 native/canonical history and `STEPSEMBLE_ACK` capability contract
  is unchanged: no upstream ACK, transcript, subagent or cross-host database
  is fabricated.

## Verification

Local Node 22.22.3 verification:

- Full suite: 1246 passed, 2 platform skips, 0 failed.
- `npm run check`, `check:protocol`, `check:client`, `version:check`, and
  `git diff --check` passed.
- Protocol conformance: 1251 cases passed.

The three-OS CI and release workflow for the final commit/tag are the release
authority; the published GitHub assets include both Stepsemble and legacy
Pi Harbor archive names.
