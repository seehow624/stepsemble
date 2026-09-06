# Pi session titles and idle process shutdown

Development candidate: **3.0.4-rc.4**, 2026-09-06. Not activated on the owner's
live Host; no public release or native account/model verification is implied.

## Root causes

- The legacy Agent Hub mapped every nonzero process exit to Failed. Installed
  Pi 0.84.2's `rpc-mode.js` explicitly handles SIGTERM with exit code 143, so an
  intentional idle cleanup could appear as a failed coding task. An idle 143
  with empty stderr alone cannot prove who sent the original signal.
- Three title rules disagreed: native Pi uses its custom session name or first
  user message; the Web list used the latest assistant preview; Agent Hub
  fell back to the JSONL filename. The screenshot did not demonstrate a
  different session or corrupted history.
- `/api/close` protected connected clients and pending dialogs, but not active
  generation or the interval between pipe acceptance and `agent_start`.
- The old deterministic test peer exited 0 on SIGTERM, missing the native 143
  behavior. New synthetic lifecycle fixtures exercise it explicitly.

## Changes

`client/pi-session.ts` is strict TypeScript, emitted as the same dependency-free
`public/modules/pi-session.js` artifact for Node and Web. It does not introduce
a new runtime package, storage format, or advertised protocol capability.

1. The Host records its idle close intent **before** signalling. Intentional
   SIGTERM/143 (and Windows owned-tree termination) is distinguished from
   unexpected exit, protocol faults, active interruption, and forced SIGKILL.
   Merely opening/closing history is Stopped, not a successfully completed run.
   An observed model failure remains Failed after normal idle cleanup.
2. Pending work commands are protected from pipe acceptance until their
   correlated native response, bounded to 64 per RPC. Close checks clients,
   pending UI/work, streaming, compaction and queues, obtains fresh native
   state, and rechecks the work revision synchronously before signalling.
   Unknown/failed state checks do not kill. Closing processes reject sends and
   reuse; concurrent metadata reads recheck identity/capacity before spawn.
   The legacy `/api/rpcs` active flag also protects preflight work from updates.
3. Summaries and paginated detail add bounded `firstMessage` (160 characters),
   separate from the unchanged latest-assistant `preview`. Latest native
   `session_info`, including an empty-name reset, wins. List, Hub, search,
   chat, actions, command palette and export use the same title precedence.
   Detail refresh overrides a stale Hub title; opening an existing file does
   not use a caller's display name to rename native history.

Closing the browser's SSE and submitting `/api/close` can reach the Host in
either order. If the old connection still exists, retaining an idle Waiting
process is correct; the idle reaper later rechecks it. There is no automatic
prompt, model retry, or reconnect-to-a-new-writer mutation.

## Evidence and boundaries

Local macOS checks: 319 tests, 317 passed / 2 Windows-only skips / 0 failures;
strict TS/generated artifacts, syntax/version and independent 1,251-case schema
conformance passed. Pinned Chromium 153.0.8010.12 passed all 8 rolling cases,
2 existing Claude-auth UI cases and 2 new Pi-session UI cases. These are
isolated synthetic tests, not real account use or a live deployment.

The first candidate commit `65d7295` passed macOS/Linux and both rolling jobs,
but Windows correctly rejected the new generated artifact after CRLF checkout.
The follow-up applies LF to every browser module (including future helpers),
adds a policy regression and includes attributes in the rolling workflow path
gate. Byte-for-byte artifact checking is unchanged; Windows must pass anew.
After the LF follow-up, local tests are 320 total / 318 passed / 2 Windows-only
skips / 0 failures; strict TS/artifact checks and effective Git LF attributes pass.

- `test/pi-session.test.js`: shared Node/browser classifier, normal and
  unexpected 143, SIGKILL, Windows termination classification, model failure,
  preflight/send/close races, client joins, compaction, revisions, concurrent
  opens, custom-name clearing, paginated title, search/export and unchanged
  synthetic history. HTTP tests use only a copied fake CLI and isolated home.
- `scripts/pi-session-browser-cases.mjs`: actual 1440/390 Chromium UI, first
  question different from last assistant answer, back/detach, safe idle close,
  Hub reopen and reload. It explicitly drives the safe close boundary after
  SSE detachment when necessary; it does not pretend that Back always stops a
  child immediately. No model prompt is sent, and history bytes stay unchanged.
- Existing two-release, two-direction browser compatibility tests and native
  dialog tests remain gates. Cross-OS results must be checked for this exact
  commit; local Mac skips do not count as Windows execution.

This is an in-process legacy Pi correction, **not** a durable run journal,
crash recovery, full native-agent parity, physical iPhone/Safari verification,
or evidence that every upstream Pi version has identical shutdown semantics.
Old Hosts without close-intent metadata retain visible error reporting; Web
falls back to old summary previews only when `firstMessage` is absent.

## Activation / rollback

The owner-approved live Host remains rc.3 until a separate safe update is
approved. Candidate rc.4 has separate asset queries/PWA cache identity. Before
activation, inspect active native/generic work, preserve the existing SSH
launcher and desktop Claude helper, and retain the installed rc.3 rollback.
No native session migration, credential copy, or history rewriting is needed.
