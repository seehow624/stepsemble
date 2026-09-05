# Native Pi RPC contract — 0.84.2

`0.84.2.json` contains **57 sanitized input/output frames captured from the
installed `@earendil-works/pi-coding-agent` 0.84.2 CLI** on macOS arm64, not a
transcript invented from the reserved Stepsemble v1 schemas. The explicit test
extension generates synthetic messages and dialogs. There are **no model calls**,
provider logins, real workspace contents or subscription credentials.

## Reproduce safely

```sh
npm run test:native:pi -- /absolute/path/to/pi-coding-agent/dist/cli.js
```

This is opt-in: the script does not install Pi, discover another CLI or upgrade
an existing package. It checks the package name and exact version. A different
version requires review. Append `--record` to print sanitized JSON for review;
the script never overwrites the checked-in golden file itself.

`scripts/check-native-pi.mjs` starts Node directly with:

- `--mode rpc --offline`, `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`;
- a fresh `PI_CODING_AGENT_DIR`, synthetic cwd and explicit session file in a
  local temporary directory, removed after the owned child exits;
- `--no-extensions --no-skills --no-prompt-templates --no-themes
  --no-context-files`, followed by one explicitly loaded synthetic extension;
- an environment allow-list that omits inherited API keys, OAuth variables,
  proxies, router configuration and `NODE_OPTIONS`.

The installed package's `docs/rpc.md`, `dist/config.js`, `dist/main.js`,
`dist/modes/rpc/rpc-mode.js`, session manager and extension API were consulted
to establish these flags and semantics. This is process/config isolation, not
an OS sandbox or packet-capture proof. The extension has no tools or model turns;
the probe asserts the isolated model catalog is empty.

## Captured behavior

- `get_state`, empty `get_available_models`, `get_session_stats`, `get_messages`;
- a custom message containing Chinese, emoji and U+2028/U+2029 separators;
- confirm true/false/cancel, select, input, editor and native timeout;
- an unknown UI request ID is ignored; an unknown command returns failure;
- idle abort and clean EOF shutdown;
- restart and re-read of the **already persisted** synthetic session, with
  the same session ID and one custom message.

Session paths become `<session-file>`, native session identity becomes
`native-session-1`, UUID request IDs become sequential `native-id-N` values,
and timestamps become zero. Remaining payloads, event order and correlation
are retained. Unclassified local paths fail capture instead of entering Git.

Pi initializes an explicitly created empty session file in this probe. Its
wholly new lazy session does not necessarily flush custom-only messages before
the first assistant response; testing that case as if it were persisted caused
a new identity on restart. The fixture therefore proves **persisted-file resume**,
not live-process survival, crash consistency or unflushed-history durability.
Pi also reconstructs a custom message's timestamp from the saved entry, which
can differ by a millisecond; timestamp normalization is intentional.

## Host and browser regression coverage

`test/pi-rpc-contract.test.js` validates captured frames and arbitrarily split
UTF-8/CRLF bytes, strict reply types, process/command correlation, bounded dialog
state, expiry and single-winner replies within one Host process. A synthetic
peer replays native shapes through an isolated real HTTP Host; its fault commands
are adversarial test inventions, not claimed Pi features.

The Host restores pending `confirm/select/input/editor` requests independently
of the legacy SSE cursor, suppresses answered historical dialogs, and emits
the additive Host event `extension_ui_closed` on answer/expiry/process exit.
Snapshots have no `id:` line. Browser EventSource can inherit an earlier event's
`lastEventId` on such a frame; the snapshot must **not advance** it, not always
produce an empty string. Repeated snapshots preserve the open input draft.

Interactive browser smoke can be started with:

```sh
node scripts/browser-performance-host.mjs --native-pi-contract
```

This launches only the replay peer and temporary synthetic data. On 2026-09-05,
Chrome verified visible confirm, reconnect with unchanged snapshot cursor,
another-client false reply closing the dialog, exactly one accepted reply, and
duplicate/expired input draft behavior. Input draft cases called the production
UI handlers directly; they are not real model/tool executions. The first smoke
assertion incorrectly expected an empty EventSource ID; correcting the assertion
to the inherited-ID rule above passed without a server workaround.

CI runs captured-byte/state/correlation tests on macOS, Linux and Windows. The
HTTP peer uses a Unix shebang and skips Windows. The real native probe has only
been run on macOS arm64; replay success is **not native cross-platform parity**.

## Deliberately incomplete boundaries

- `{sent:true}` means the Host accepted a reply into the pipe queue. Native Pi
  emits **no correlated UI reply ACK**. Do not label this durable/native success.
- Dialog state is bounded to 32 requests, 64 KiB each and 256 KiB total, and
  lives only as long as this Host process. Timeouts use a monotonic clock; only
  a positive native timeout expires a request. Expiry never grants permission.
- There is no persistent approval nonce/idempotency ledger or exactly-once
  execution across Host restarts. Upstream AbortSignal cancellation may not emit
  a close frame; the Host cannot infer every upstream cancellation.
- The current Web sheet still displays one dialog at a time, not a queued
  multi-approval inbox. A failed reply request can require reconnect to restore
  the pending dialog. These need further client state/recovery work.
- Pi's Windows npm `.cmd` launch/argument/path/process-tree behavior still needs
  a native runner check and remediation; the prior generic-agent shim fix does
  not cover `openRpc`, model catalog or Pi version probing.
- Model/tool streaming, interruption during a real turn, auth/subscription
  behavior, multiple native versions, crash/power loss, Host-restart survival
  and previous shipped Client compatibility remain outside this fixture.

Continue [Phase 1](../../../docs/platform-plan.md), including stateful commands,
snapshot recovery and rolling compatibility. Do not promote this partial native
contract to a completed durable journal or full agent adapter.
