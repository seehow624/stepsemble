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

There is now a separate **test-only installation** entry point:

```sh
npm run test:native:pi:runtime
npm run test:native:pi:runtime -- --audit
```

`scripts/check-native-pi-runtime.mjs` installs the exact 0.84.2 graph from
`scripts/native-pi-runtime/package-lock.json` into a disposable local temporary
directory. It never touches the existing installed Pi or project `node_modules`.
Installation uses the public npm registry, SHA-512 integrity for every package,
disabled install scripts, empty user/global npm configs, an allow-listed
environment and a private temporary cache. The production Host still has no npm
runtime dependencies. The audit mode reads the locked graph without installing
or running Pi; the initial local audit reported zero known vulnerabilities.

The explicit maintenance option `--update-lock` regenerates only that test lock.
Pi's published shrinkwrap omitted integrity values for six first-party 0.84.2
packages. The generator supplements them from exact public version metadata,
requiring matching package name/version/tarball URL and SHA-512; it does not relax
the runtime's integrity requirement, float versions or silently switch sources.
Review changes before using the resulting lock. Normal tests and CI never update it.

The `Native Pi offline contract` workflow runs the real CLI probe on macOS,
Windows and Linux for relevant changes and manual dispatch. The new clean local
darwin/arm64 install passed all 57 frames. Cross-OS native results must be checked
on the corresponding workflow run before treating them as verified. The regular
CI suite also checks the lock/source policy without downloading or launching Pi.

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

CI runs captured-byte/state/correlation and isolated HTTP peer tests on macOS,
Linux and Windows. On Windows the peer runs behind an actual `.cmd` shim:
version/model probes, launch arguments, replies, SSE and owned-child exit are
exercised. This replaces the previous Windows skip. The real native Pi probe
was initially run only on macOS arm64; the separate real-CLI matrix described
above extends the offline check. Replay alone is **not native cross-platform
provider/tool parity**, and the real offline probe still has no model/provider turns.

## Queued dialogs and launch follow-up — Plan 1.11

`client/native-dialogs.ts` is the strict, dependency-free, page-lifetime queue,
compiled and checked alongside the Client SDK. It validates incoming requests,
bounds replay to the Host's count/byte limits, keys by Host/session/request and
displays FIFO. Duplicate snapshots preserve the current draft; queued close
events remove only their own request. Old clicks and late HTTP results cannot
answer, dismiss or resurrect another request.

During a native reply, controls are disabled and the request has one in-flight
send with a 12-second deadline. Failed/unknown delivery retains the visible
input and permits **manual** retry, never automatic side-effect retry. A known
404/409 dismisses the stale request; a close event from another client wins over
a late response failure. `sent:true` is still only pipe-queue acceptance.

Provider sign-in UI temporarily suspends the native sheet and restores its
draft when sign-in UI closes; provider secrets are not copied into this queue.
Host switch/sign-out detaches old login UI locally instead of retargeting it.
Leaving a chat clears local dialog data but does not close a Pi waiting for
input; the Host's pending snapshot can restore it on reconnect. No draft is
saved to localStorage or disk. Losing/reloading the page still loses its draft.

Chrome mobile-emulation smoke used two synthetic requests, real Offline/online
network toggling and manual button clicks: no automatic retry, input retained,
FIFO advance, false/cancel and two accepted replies. State tests also cover
provider preemption, expiry, duplicate click, stale Host/session and late HTTP
completion. This is not an iOS/Android physical-device or performance test.

`server/pi-launch.js` now supplies one launch configuration to RPC, temporary
model discovery and version probing. Windows uses a resolved absolute `.cmd`
through restricted `cmd.exe`, correct PATH casing/delimiter, hidden window and
no second detached console; Unix retains its own process group. Windows stop
uses bounded `taskkill /PID <owned pid> /T /F`, which is forceful, not a graceful
Unix signal. The version probe still uses bounded synchronous IO (Phase 3 work).

Shell expansion characters in batch-shim paths or arguments are explicitly
rejected, not escaped optimistically. For a path/name containing `&`, `%`, `!`,
quotes or other rejected shell characters, the Host owner can explicitly set
`PI_BIN` to the installed `dist/cli.js` path. On Windows it is then launched with
the Host's Node binary and literal argv, with no shell. Stepsemble never guesses
another package behind a wrapper, bypasses its routing configuration, or edits
native login files. Windows native package/resource/auth discovery beyond these
core launch paths remains unverified.

## Authoritative pending-set recovery — Plan 1.12

The new Web client requests `/api/stream?sid=...&after=...&uiSnapshot=1`.
The named `connected` frame adds `nativeUiSnapshot`:

```json
{"type":"native_ui_snapshot","version":1,"sid":"synthetic-session","requests":[]}
```

`requests` is the complete ordered set from this Host process, including an
explicit empty set. It contains native request shapes, bounded by the same
32-request / 64 KiB each / 256 KiB aggregate limits. The frame has no SSE id and
must not advance the conversation cursor. It is not a Protocol v1 journal
snapshot, persisted record, approval nonce or upstream acknowledgement.

The Host collects this set and registers/replays synchronously without an await
between them. Opt-in replay omits historical interactive requests and closes:
they cannot overwrite this newer state or close a newly reused native ID.
Subsequent live request/close events still follow in the same SSE order. Legacy
clients without the query keep the existing additive path; a new client with an
old Host uses its existing connected/onopen fallback. This focused compatibility
coverage is not the two-shipped-release rolling matrix.

The strict TypeScript queue validates and stages the entire replacement before
mutating any request/draft. Bad version/sid, duplicate IDs, malformed requests
or count/byte overflow leave prior data untouched. Unchanged requests preserve
their object identity, draft and in-flight state. Missing or changed requests
are removed; stale HTTP completions cannot alter their replacements. Provider
sign-in UI and unrelated Host/session scopes are not cleared by reconciliation.

Callbacks/timers are fenced by connection object, view generation, Host and
EventSource identity. On a stream failure after negotiating snapshots, native
replies are disabled until a valid full snapshot arrives. Transport-open alone
does not enable them. Invalid snapshots use bounded reconnect backoff without
advancing the cursor, clearing drafts or retrying side effects.

The isolated HTTP test emits 8,100 events to evict the entire 8,000-event ring,
then checks partial/empty sets, ID reuse, live closes and cursor neutrality.
[Browser evidence](../../../docs/baselines/native-ui-recovery-2026-09-05.json)
uses two synthetic pages and an explicitly injected SSE close/error while
Offline prevents new requests. CDP Offline alone left an established SSE alive;
it must not be described as proof of an actual transport disconnect. No native
provider login/model calls, real accounts or physical devices are involved.

## Deliberately incomplete boundaries

- `{sent:true}` means the Host accepted a reply into the pipe queue. Native Pi
  emits **no correlated UI reply ACK**. Do not label this durable/native success.
- Dialog state is bounded to 32 requests, 64 KiB each and 256 KiB total, and
  lives only as long as this Host process. Timeouts use a monotonic clock; only
  a positive native timeout expires a request. Expiry never grants permission.
- There is no persistent approval nonce/idempotency ledger or exactly-once
  execution across Host restarts. Upstream AbortSignal cancellation may not emit
  a close frame; the Host cannot infer every upstream cancellation.
- The queue covers the currently attached native session, not a durable
  cross-session approval inbox. Full pending-set recovery requires both the new
  Host and opt-in Client; old peers keep their earlier limitations. This repairs
  only UI state: missing message/tool events still require native-history or
  future durable projection recovery, and the legacy numeric cursor has no
  journal generation. Identical reused native IDs have no incarnation nonce.
- Provider sign-in retry/durability and its underlying native flows remain
  separate from this native Pi dialog queue. No real sign-in was exercised.
- Model/tool streaming, interruption during a real turn, auth/subscription
  behavior, multiple native versions, crash/power loss, Host-restart survival
  and previous shipped Client compatibility remain outside this fixture.

Continue [Phase 1](../../../docs/platform-plan.md), including stateful commands,
snapshot recovery and rolling compatibility. Do not promote this partial native
contract to a completed durable journal or full agent adapter.
