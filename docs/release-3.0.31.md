# Stepsemble 3.0.31 release candidate

This release tightens the native agent boundary and adds real ACP support for
Cline, Kilo Code, and Hermes.

- Claude Code structured sessions now use Claude's host control channel for
  `can_use_tool` requests. Allow/Deny responses are correlated to the native
  request ID and the original tool input; unknown, duplicate, or legacy
  permission frames fail closed.
- Claude turn stop now sends a native `interrupt` control request. Closing a
  session remains a separate operation, so a stopped turn can be resumed in
  the same native session.
- Claude's restart index stores only the validated native session ID, allowed
  project directory, and display name; selecting an entry after a host restart
  starts Claude with its documented `--resume` path.
- Added one bounded ACP v1 stdio adapter for Cline (`cline --acp`), Kilo Code
  (`kilo acp`), and Hermes (`hermes acp`), covering initialize, session
  create/load, prompt/update, cancel, and option-bound permission responses.
- Persist only a bounded restart index of upstream session IDs, allowed project
  directories, and display names. On a later host start, selecting an entry
  asks the ACP agent to perform `session/load`; the upstream agent remains the
  transcript authority.
- ACP bridges preserve upstream session IDs and never scan private credential,
  SQLite, gateway, Telegram, or history stores. Each bridge can be disabled
  independently with `STEPSEMBLE_{CLINE,KILO,HERMES}_ACP=0`.
- Agent Hub and chat UI now show ACP event streams and native permission
  options, and the task center stop action uses ACP cancellation for these
  agents.
- Codex's reviewed-version gate remains unchanged; the locally installed
  alpha continues to fail closed to the bounded CLI path until its app-server
  schema is reviewed and fixture-tested.

Validation includes the ACP and Claude control-channel fixtures, the full Node
test suite, protocol conformance, client checks, syntax checks, a short restart
soak, version synchronization, and `git diff --check`.
