# Claude native history boundary

Reserved implementation and synthetic test evidence, not an installed production
adapter. The Web still uses the existing terminal supervisor and opt-in macOS
desktop helper. Registry, HTTP/relay/identity adapters and an isolated preview now
exist, but production `server.js`/`public/app.js` do not enable them. No SDK runtime
dependency, provider login change, model call or private native history read is
introduced by this batch. The earlier explicitly scoped owner-session experiment
at the end of this document remains separate evidence.

## Pinned official reader

`scripts/check-native-claude-history.mjs` uses official Agent SDK **0.3.259**,
whose package declares Claude Code **2.1.259**. Both metadata and the exact
bundled `sdk.mjs` SHA-256 must match before import. `--download` fetches one public
SHA-512 integrity-pinned tarball and extracts only SDK JavaScript/package metadata
into local temporary storage: no npm dependency tree, install scripts or native
CLI. The SDK itself is not vendored or relicensed by this repository.

```sh
node scripts/check-native-claude-history.mjs --download
# Or use an already obtained, matching official SDK module:
node scripts/check-native-claude-history.mjs /absolute/official-sdk/sdk.mjs
```

The parent creates synthetic JSONL under a fresh HOME. The reader runs in a
separate Node 22.19+ permission-mode process with only fixture/SDK/script read
access, no filesystem-write or child-process permission. Actual negative
canaries verify these two restrictions. No native credential/settings paths are
granted or read by the reviewed fixture workflow. Node's permission mode here is
**not network isolation or a sandbox against malicious code**;
the reviewed code calls only `getSessionMessages`/`getSessionInfo`, never query,
startup, login, resume or mutation APIs. The public SDK download itself needs network.

The fixtures include a branched transcript, Unicode, internal queue/title records,
two assistant rows belonging to one API response, tool/error/attachment/thinking
content and a compacted branch with explicitly preserved native messages. Tests establish:

- Native parent-chain selection and row order are preserved, not flattened by
  timestamps or read order across alternative branches.
- Message `uuid` is the row identity. Multiple rows may share `message.id` within
  one API response; collapsing them by that API ID loses history.
- Native custom title, pagination, session correlation and Unicode survive readback.
- Missing/invalid sessions return an empty array. **An empty SDK result is not
  sufficient proof of an empty valid history**; a future Host must distinguish
  unavailable/corrupt/missing sources before publishing an empty projection.
- The synthetic native JSONL and the imported SDK source are unchanged afterward.
- The actual pinned reader omits outer `aborted`, `error`, `isApiErrorMessage`,
  `isCompactSummary` and system `subtype` metadata. System records require
  `includeSystemMessages: true`. Matching native records can recover these
  flags; visible text alone cannot replace them.
- A preserved-message compaction returns boundary/summary/preserved messages/new
  reply in SDK-selected order, including old timestamps after a new summary.
  We do not rebuild the native branch by sorting timestamps.

Ordinary `npm test` only checks synthetic fixtures and guards, without SDK download.
The separate Native Claude history contract workflow runs the pinned real SDK
reader on macOS, Linux and Windows; it does not run any native agent/model.

## Detached history observations (Plan 1.34)

`history-observation.js` is a Host-side reference mapper, not a public endpoint,
client capability, runtime adapter or journal importer. `observeHistory` accepts
only `{ sessionId, messages, nativeRecords }` as detached JSON. The SDK's selected
main-session **page** supplies order; the caller supplies the same stable source
records. Exact UUID/session/type/message equality is required before recovering
outer native metadata. This equality is not authenticated file ownership or a
stable-read implementation. No filesystem, network or execution API is called.
Reported boolean flags retain `null` for absent, distinct from explicit `false`;
cyclic native parent identities reject the batch rather than accepting the SDK's
potentially truncated chain as complete.

The observation separates recorded text, thinking, opaque redacted thinking,
tool requests/results, attachment references and compaction boundaries. Tool
output is labelled `result_recorded`/`error_result_recorded`, never an approval
ACK or a verified run terminal. Missing results stay `request_only`; requests
outside a page remain explicitly unavailable. API message IDs never deduplicate
distinct row UUIDs. No token totals or model-run boundaries are guessed.

Attachment references contain a native block digest and descriptive type/title,
not base64 data, URLs or file capabilities. Opaque thinking payloads/signatures
are not displayed or decoded. Native files remain necessary for full-fidelity
recovery. Unsupported blocks/metadata, source gaps and unmaterialized attachments
produce fixed warning codes rather than silently disappearing. Known malformed
blocks, mismatched content, foreign scopes and duplicate identities reject the
**whole** observation without returning partial rows. Subagent pages are not yet
accepted; null parent metadata alone must never be treated as ownership proof.

Limits: 16 MiB combined decoded input, 2,000 native records and selected rows each,
4,000 blocks including tool-result children, 262,144 code points per text field;
shared references, getters, cycles, invalid Unicode and non-JSON values are
rejected by the existing canonical JSON guard. The source boundary below now
caps raw bytes **before** JSON parsing; its live authorization gates remain open. This is a
bounded reference implementation, not evidence of UI/main-thread performance.
Digests use SHA-256 of the existing sorted-JSON encoding, with separate
source/selection/row/block fields; they detect changes, not authenticity.

Every successful observation is explicitly `publishable: false`, with no source
authentication, approval ACK, run-terminal or resume authority. Never pass these
objects directly to `planObservedEvents` or invent the missing run/approval facts.
The pinned worker checks rich/compacted observations using the actual SDK and
before/after fixture bytes. Ordinary unit tests additionally cover malformed
input, page gaps, unknown extensions and non-authority. Both use synthetic data;
this batch does not reopen the owner's native session or spend model allowance.

## Read-only source snapshots (Plan 1.35)

`history-source.js` adds a reserved source reader and strict whole-file parser;
it is still **not imported by the production server**. The trusted caller must
resolve an authorized canonical `projectsRoot`, one opaque `projectKey` and one
session UUID. These are not a browser-supplied arbitrary-path API. No directory
enumeration, native configuration/auth access, write, repair or retry occurs.

On macOS/Linux the capture checks current effective UID, no group/world write
bits, regular-file type and a single hardlink. Root/project/file symlinks are
rejected; OS ancestor aliases such as `/var` are canonicalized. It opens only
`O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, checks descriptor identity against the
observed entry, reads twice in bounded 64 KiB chunks, compares bytes and
device/inode/size/nanosecond mtime/ctime/link metadata, and rechecks file and
directory identities afterward. Descriptor close is attempted on all settled paths;
an uncertain close failure quarantines that reader, with no further capture or
close retry against a potentially reused descriptor number.
An observed append/truncate/replacement/removal or byte mismatch returns no rows.

This is an **observed-consistency and POSIX owner/mode baseline**, not proof that
Claude wrote a file, caller authorization, an ACL audit, an atomic filesystem
snapshot or protection against a malicious same-UID process doing undetected
ancestor swap-and-restore. Node path checks are not descriptor-relative
`openat`/`openat2` containment. Native authenticated source registration, stronger
platform filesystem primitives and a reviewed threat model are still required
before live use. Therefore `sourceAuthenticated` and `publishable` stay false.

Windows returns `source_platform_unsupported` **before any source IO**. Node's
Unix-like mode/uid fields must not substitute for Windows owner/ACL/reparse-point
validation. Native SDK CI still checks its own newly created synthetic bytes on
Windows, but explicitly reports `sourceSnapshotGate: platform_unsupported`;
macOS/Linux report `posix_fixture_passed`. This is not a Windows source gate pass.

The parser accepts at most 8 MiB raw UTF-8, 1 MiB per line excluding LF, and
2,000 records. It retains CRLF/LF in the raw SHA-256 while returning parsed JSON.
Blank rows, malformed middle rows, invalid UTF-8/BOM/Unicode, over-limit data,
unreviewed unscoped/foreign records and any newline-less tail reject the whole capture.
An empty file is `source_empty`, not an empty valid session. No truncated tail is
silently trimmed. Plan 1.36 adds the two narrowly reviewed ancillary forms below;
other records without `sessionId` remain unavailable, not guessed into scope.
Duplicate native identities and parent cycles remain the observation mapper's
responsibility. Digests are corruption/consistency checks, not credentials.

One source capture per reader remains in flight until all underlying IO and
cleanup settle; other requests return `source_busy`. The five-second elapsed
budget is checked between operations and does **not** cancel or put a hard
deadline on a blocked kernel/network filesystem call. Plan 1.37 adds the reserved
subprocess service below; direct callers still do not get a hard IO deadline.
Do not create a new reader/service to evade an occupied flight or quarantine.

Tests inject append, truncate, replacement, deletion, parent replacement, unchanged
descriptor metadata with differing bytes, outstanding IO, budget failure and
close failure on owned local fixtures. The pinned SDK worker checks source
capture identity/bytes before and after its rich/compacted fixture readbacks on
macOS/Linux. The worker's temporary HOME is canonicalized before its read-only
permission grant, preserving macOS `/var` alias compatibility without granting
access to a wider directory. No owner session or model is used by these tests.

## Ancillary record scope profile (Plan 1.36)

`history-record-scope.js` is shared by the raw parser and detached mapper, so
their acceptance rules cannot silently diverge. The native writer bundled in
`@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.259` (Claude Code 2.1.259) was
inspected **as bytes, never executed**. Its `insertFileHistorySnapshot` and
`sQn`/`insertFileHistoryDelta` paths serialize these envelopes without adding
`sessionId`; `appendEntry` chooses the current session file separately. Reviewed
native binary SHA-256:
`884baa38fe1a624be25c4a91568bf5a08b5cf4e7d7acf29b7760e3525d964898`.
This is a version-specific source review, not a stable public writer schema or
proof of real Windows/Linux native writer behavior. CI still downloads only the
existing pinned SDK JavaScript and metadata, not a native binary.

- `file-history-snapshot`: outer `messageId`, `isSnapshotUpdate`, and a snapshot
  containing `messageId`, `trackedFileBackups`, `timestamp`, optional `preCheckpoint`.
- `file-history-delta`: `messageId`, `snapshotMessageId`, `trackingPath`, `backup`,
  `timestamp`. The backup profile accepts `backupFileName` (string or null),
  positive safe-integer `version`, `backupTime`, and optional `realParentDir`.

Known envelopes require the reviewed fields and reject unknown additions.
Timestamps use the native ISO-millisecond UTC shape; file/path strings are
bounded to 4,096 UTF-16 units and a snapshot to 1,000 tracked files, within the
existing raw/JSON limits. These are Stepsemble's conservative supported limits,
not claims about the maximum native format. Dates, booleans, arrays-as-objects,
invalid versions and authority-looking extra fields are rejected. An explicit
foreign/null `sessionId` rejects even on a known envelope.

All referenced IDs must match unambiguous user/assistant rows with the requested
session ID in the **whole same source**, including references appearing later
or outside the selected SDK page. Missing, duplicate, metadata-only, sidechain,
team or agent references return `source_ancillary_reference_unavailable` /
`native_ancillary_reference_unavailable`, with no partial result. A file being
written with its anchor not yet present is unavailable; this does not establish
corruption, and the reader never trims, repairs or retries it automatically.
Outer and snapshot IDs are retained separately; no native checkpoint replay,
last-wins merge, restore or rewind semantics are inferred.

No `sessionId` is injected into an unscoped record. An auxiliary descriptor has
its source index, native type, reference IDs and digest, with
`scopeEvidence: same_file_message_reference` (or `recorded_session_id` when
explicitly present). **Correlation is not authorization or native provenance.**
The observation's `auxiliaryCoverage: whole_source` is separate from its SDK
message-page coverage. It contains no raw paths, backup names or metadata body;
raw parsed source records remain necessary for lossless recovery.

Scoped non-transcript metadata now also receives a digest/index descriptor and
`native_metadata_not_mapped` warning. A title's UUID never becomes a transcript
parent or fills a missing message gap: only the five SDK graph types
user/assistant/system/progress/attachment can enter that map.
Those transcript-like records must have valid unique UUIDs, rather than silently
disappearing as metadata when their identities are absent.
File-history records produce `native_file_history_not_materialized`; backup
paths/keys (including traversal-looking strings or `__proto__`) are inert values,
never opened, followed, merged into application objects or exposed as restore
capabilities. `publishable` and all four authority fields remain false.

The real pinned SDK reads an additional synthetic file-history transcript with
snapshots, a delta, update, title UUID, forward references and pagination. The
raw source survives unchanged; selected branch/title agree; only inert auxiliary
descriptors are returned. Nine regression tests exercise valid and malformed
envelopes, out-of-page/foreign/ambiguous links, unknown extensions, byte/digest
preservation, metadata graph separation and bounds. This does not validate all
unscoped forms (e.g. summary/attribution snapshots), subagents, interrupted tails,
native file-backup restore or authenticated source binding. The process lifecycle
reference below is a separate gate, not part of the native writer contract.

## Bound, cancellable source workers (Plan 1.37)

`history-source-service.js` is a reserved Host-only reference, **not imported by
the Web server**. `createSourceService()` owns a shared two-worker ceiling, no
queue and no automatic retries. A trusted Host calls `bind({ bindingId, generation,
source })` after authorizing a canonical projects root, project key and native
session UUID. The binding is detached from caller objects. The returned opaque
handle exposes a frozen descriptor, `capture(request, { signal })`, `revoke()`,
and read-only `status()` with `revoked`, `activeWorker`, `cleanupConfirmed`.
The latter confirms that no worker is active only after actual child/stdio close,
or when no worker was launched; a settled cleanup-timeout promise is insufficient.
Capture accepts **only** `{ bindingId, generation, requestId }`: no path, session
override, authority flags, executable, environment, timeout or worker options.
IDs/generations must match the handle exactly before launching anything.

This is **trusted binding/fencing, not authenticated registration**. The bind
method must never be exposed to a browser or treated as proof of native file
ownership. Dependencies and shorter timing overrides are trusted in-process
test seams, not request parameters. A spawn dependency must return the newly
owned ChildProcess or throw before launch; it must not detach an untracked child.
`requestId` is correlation, not persistent idempotency or a journal receipt.

There is one active capture per binding, at most two per service. The Host must
share one service rather than instantiate one per request. Retained binding-ID
tombstones are capped at 64; a revoked ID can be rebound only after cleanup and
with a strictly higher generation. Old handles remain revoked and cannot read a
new source. These generations/tombstones live only for that service lifetime;
they are not a crash-safe ownership registry or durable replay fence.

Each capture starts the fixed `history-source-worker.js` with the current Node
executable (no shell/detach), an explicit 128 MiB V8 old-space limit, permission
mode, no write/child/worker grants and a filtered environment. No inherited HOME,
credentials, provider routing or NODE_OPTIONS/loaders are passed. The worker
loads only the source/parser/wire modules and canonical JSON helper, not the SDK
or any native agent/model/login API. It runs one source capture and exits.
Source read/parse work is outside the Host process. Parent response decoding and
validation remain synchronous but byte-bounded; large-history/event-loop/RSS
performance still needs measurement. The V8 limit is **not a total RSS limit**;
OOM or unsupported input fails without rows, not a claim that every 8 MiB native
history is usable under this worker budget.

Private wire version 1 uses one bounded UTF-8 JSONL request (12 KiB) and response
(10 MiB, at most 4,096 output chunks), correlated by a fresh 256-bit nonce and all
request IDs. Wrong version/nonce/generation/session, invalid encoding/tail/extra
frames, unexpected fields, invalid snapshot metadata or source scopes reject
without partial data. The parent never trusts elevated `publishable` or
`sourceAuthenticated` flags. Digest/identity reports from this trusted worker
are observed evidence, not authentication of an arbitrary executable. Stderr is
discarded and marks the request failed; raw diagnostics never escape to callers.

The service has a 10-second elapsed request budget, plus up to one second to
observe cleanup after cancellation/failure. A timeout, AbortSignal, revocation,
shutdown or protocol/output failure issues **at most one SIGKILL on the fresh
ChildProcess object**. No saved PID, process-group scan, task tree or production
service is targeted. A response alone is insufficient: success requires the
worker/stdio `close` event with exit code zero, valid correlation, live binding,
no observed abort and unexpired elapsed budget. Revoked/cancelled late output
cannot become a successful snapshot. Repeated/late child errors are absorbed.
The worker also has its own 10-second exit watchdog as a backstop if the parent
disappears during pending asynchronous IO; it exits only itself. This timer also
depends on its event loop and does not replace crash recovery or OS containment.

If cleanup cannot be confirmed, the request resolves with
`source_cleanup_unconfirmed`, the slot stays occupied and the **whole service
is quarantined**. No further registration or capture is permitted. A late close
can release the slot but never publishes the old result or clears quarantine.
`shutdown()` revokes bindings, requests only owned-worker termination, waits for
their bounded request results, and reports whether cleanup was actually observed.
The Host must not create a replacement service to conceal an unconfirmed child.
Timers require a responsive parent event loop; an OS process in uninterruptible
IO may resist termination. This is bounded wait/fail-closed lifecycle logic,
**not a hard real-time cancellation or guaranteed kernel-resource cleanup**.

Important filesystem limit: Node grants a directory's descendants. The read
grant covers the **registered projects-root subtree**, plus exact implementation
files, not only the selected JSONL. Tests confirm specific direct outside-root
reads/writes/spawn are denied and another path inside the root remains readable.
Node's documented limitations include symlinks that can lead outside granted
paths and existing descriptors that bypass path permissions. These canaries do
not establish arbitrary-path or malicious-code containment.
Reviewed worker code reads only the immutable selected source, but this is not
single-file OS isolation, protection from compromised worker code, or a complete
symlink/ACL/network sandbox. Wildcard/broad filesystem roots are rejected;
canonical-root authorization, native provenance and descriptor-relative/ACL
containment still belong to future platform gates. No production credentials or
private histories are used to test these grants.

Windows service capture returns `source_platform_unsupported` before spawning;
Node permission/kill/framing logic can still be tested on Windows using synthetic
workers, **without claiming a Windows native-source ACL gate passed**. Ordinary
cross-platform CI includes the 15 new tests: immutable scope, no-queue capacity,
generation/revoke races, cancellation, timeout/exit gating, launch/stream failures,
wire tampering/chunking, permanent quarantine and bounds. Real subprocess tests
cover a stuck worker while the parent timer keeps ticking, permission denials,
and POSIX synthetic snapshots with unchanged source bytes. A simulated worker
context separately checks its self-watchdog with unresolved IO. All successful bound
snapshots remain `sourceAuthenticated: false`, `publishable: false`; there is no
live history UI, approval acknowledgement, resume or durable store. The optional
snapshot SDK selection below shares this lifecycle; raw `capture()` remains a
diagnostic reference and still has a much larger synchronous parent decode.

## Pinned SDK selection inside the source worker

Trusted Host construction may provide an already-managed, canonical absolute
`sdkPath` to `createSourceService({sdkPath})`. There is no runtime package install,
default SDK discovery or browser-supplied executable path. `bound.observe(request,
{page: {offset, limit}, signal})` keeps the exact binding/generation/request identity
and shared worker/revocation/cleanup limits. Offset is 0–2000, limit 1–100 (default
0/100). Extra options, getters and invalid pages are rejected before spawning.
Calling raw `capture()` cannot enable SDK mode through extra arguments.

After one stable source capture, the worker reads the SDK from one descriptor in
bounded 64 KiB chunks, checks metadata/EOF and the exact reviewed SHA-256, and
closes the descriptor before import. The 4 MiB input cap also bounds growth races;
there is no unbounded `readFile()` after a stale size check. Synchronous Node
`registerHooks` supply the **already verified Buffer** to the exact SDK module URL.
The resolve hook prevents a swapped symlink from redirecting module resolution;
a random URL query excludes a preexisting plain-path ESM namespace while keeping
the file URL semantics needed by `import.meta.url` and `createRequire`.

Hooks are deregistered in `finally`, and the artifact is read/verified again after
evaluation to retain observed-drift rejection. Each owned worker/module permits
only one SDK attempt, including failures and uncertain descriptor close; this
matches one job per worker and avoids an unbounded nonce-module cache. There is
no production override for the pin or import dependencies. A source path remains
trusted Host configuration, not request data.

This closes the root SDK's verified-bytes-versus-evaluated-bytes gap. It does not
authenticate native JSONL, audit ACLs, sandbox malicious code or guarantee the
entire dependency graph/OS/network boundary. The reviewed pinned bundle's offline
reader is still the only SDK API used by this worker. There is no extra
write/child/worker permission and no provider credential or native CLI startup.
Nine loader tests cover overwrite/symlink swap-and-restore, stale ESM cache,
post-evaluation drift, bounded growth/short reads, uncertain close, one-shot
failure and the unchanged permission profile. These pass on actual Node 22.19.0;
synchronous hooks were introduced in Node 22.15.0.

The official 0.3.259 alpha `getSessionMessages` accepts `sessionStore`. Our store
serves exactly one detached in-memory snapshot to one matching synthetic-project
key/main-session load; writes, other sessions, subpaths and repeated loads throw.
Even a caught denial prevents success. No filesystem transcript discovery,
materialization, import-to-store, query, resume or login API is invoked. The SDK
may rewire compaction parents in its disposable copy; the original native records
remain unchanged for `observeHistory` comparison and digesting. This is a pinned
public API, not a reimplementation/eval of private branch-selection internals.

Successful `bound_history_observation` includes an inert observation, selected
page, pinned-reader identity, full-source summary/hash/identity **without raw
records**, and diagnostic timing/high-water metrics. Whole-frame output is capped
at **256 KiB**, independently enforced in child and parent. Too large returns
`source_observation_too_large`, not truncation or automatic retry. Parent validation
checks exact envelopes, page/source/session/SDK correlation, bounded content
shapes, digests/references and every non-authoritative flag. It does not establish
native provenance or recreate the source from a page.

The all-OS pinned SDK contract compares memory-store selection with official
filesystem selection, including branch, compaction, ancillary data and unchanged
input. macOS/Linux additionally exercise the actual owned `observe` worker,
partial pages, oversize rejection and explicit smaller-page recovery. Windows
returns `platform_unsupported` at the source boundary. Eight ordinary tests cover
detachment, store scope/write denial, option and page bounds, cancellation,
tampered responses and rejection of changed SDK bytes before execution.

[Local large-history results](../../../docs/claude-history-performance.md) show
reduced parent decode/validation work, not complete UI/latency/memory acceptance.
Every page still rereads/selects the whole bounded source. The version fence below
rejects changed sources; it does not cache/index old snapshots or establish
peak-RSS pressure safety or authenticated publication.

## Source-version fence for successive pages

An unversioned `bound.observe(request, {page})` starts a new view. Only a successful,
validated result **after owned-child close** returns `sourceVersion`, a random
256-bit opaque token. Subsequent pages must pass that token as
`bound.observe(nextRequest, {page: nextPage, version: first.sourceVersion})`.
An unversioned result is a replacement view, **never an append to an old view**.
The reserved [typed Client view](../../history-pages.md) keeps request/view fencing
and only combines the same Host/binding/generation/session/version and source
identity. It is tested with the real bound worker on owned POSIX fixtures and now
with the reserved authenticated HTTP transport. Production Web integration is
not enabled.
Plan 1.41 shares the strict TypeScript provider/observation validation between
this worker wire and the Client; generated `claude-history*.js` are exact read
grants in the owned worker, not native SDK imports in a browser. The decoder can
bound and validate a supplied inner JSON payload, but does not implement streaming
HTTP collection or source registration itself. Those now have separate reserved
implementations described in the [access status](../../../docs/history-access-design.md).

Each binding holds only one token and a detached small fingerprint: raw-file
SHA-256 plus device/inode/size/mtimeNs/ctimeNs. No history rows, arbitrary cursor
map or copy of native credentials is retained. Tokens belong to this exact service
instance and binding generation; they do not survive restart or authenticate the
caller/native origin. They have no wall-clock TTL: refresh, revoke, shutdown or
an observed mismatch invalidates them. Use the single shared Host service, not a
new instance per page.

- A matching continuation rereads the bounded source using the existing POSIX
  consistency gate. The worker compares the captured fingerprint **before SDK
  import/selection**; the parent independently compares the returned summary.
  Different bytes, inode, size or nanosecond timestamps return
  `source_version_changed` with no page; that token cannot revive if bytes later
  return to their previous value. A new explicit unversioned read is required.
- Unknown, foreign, revoked or superseded tokens return
  `source_version_unavailable` before spawning. Malformed tokens return
  `invalid_history_version`. A request cannot supply its own fingerprint/path.
- Successful explicit refresh replaces the previous token even if bytes are
  unchanged. Failed/cancelled refresh, transient IO errors, or oversize responses
  do not replace it; a later continuation still has to pass the full source gate.
  A caller may explicitly request fewer messages after an oversize page.
- This is a version mismatch detector, **not MVCC/file locking or an old snapshot
  cache**. Native writes after capture can make the delivered page stale; writes
  that were never observed are not audited. No atomic filesystem/provenance/ACL
  guarantee, approval ACK, run-terminal or resume authority follows from a token.

Eight additional ordinary tests cover detached fingerprints, continuation/repeat,
refresh failures/cancellation, token replay across scope/generation/service,
late cleanup, changed identities and real POSIX append/edit/truncate/replacement
rejection before an unavailable SDK could load. The pinned official SDK contract
also exercises unchanged continuation, then an owned-fixture append, rejection,
token retirement and explicit refresh. Windows source gates remain unsupported.

The [dual-worker experiment](../../../docs/claude-history-performance.md#dual-worker-versioned-pages--plan-139)
keeps one service through 12 rounds/24 reads and verifies the third admission
fails without a new spawn. It is not an OS memory-pressure or leak-proof test.

## Reserved registry, identity, HTTP and relay access

`history-registry.js` accepts a fixed trusted catalog (at most 256 sources) and
current principal/authorization callbacks. Client input selects an opaque catalog
ID, never a filesystem/SDK path. A principal is a Host-created stable reference,
a view UUID separates lifecycle, and each principal/view/source owns a distinct
binding/version. The registry retains no transcript rows or raw credentials.

One shared source service backs at most 64 stable registry slots. Release,
principal revoke, source withdrawal, lease expiry and shutdown invalidate rows
synchronously before worker termination. Reuse requires the handle's actual-close
status and a strictly greater generation. An idle slot can atomically change
owner; old callbacks/credentials/tokens cannot gain the new binding. Active or
closing slots are unavailable, and late close never clears service quarantine.
Both mock token churn and the actual service exercise 1,000 cross-owner/session
registrations with one retained binding ID; registry tests cover the remaining
scope, capacity, lifecycle and real owned-fixture cases.

Unobserved registrations are tentative. Private `cancelRegistration(principal,
receipt)` compares the latest original object identity, not a JSON receipt field;
old/cloned receipts cannot revoke renewed scopes. First valid observe claims the
row synchronously and disables registration rollback permanently, including after
later renewals. An authorized source change may replace a same-principal/view
tentative row when its first registration reply was lost; claimed rows still
require release. The new catalog is authorized before retiring the old row, and
generation/actual-close/quarantine rules still apply. Cancellation success means
logical retirement, not physical cleanup confirmation.

The default lease is 60 seconds (trusted range 1 ms–24 hours). Explicit register
of the same view/source renews it; observe alone does not. An expiry timer revokes
even idle/in-flight views, with additional checks on operations and publication.
This is a registry lease, not a new sourceVersion TTL or permission to stop native
Claude work. Source versions/generations are still process-local, not durable.

`server/history-identity.js` derives bounded opaque principals from injected live
browser token and peer-grant authority. It retains at most 21 browser and 128 peer
entries, with salted fingerprints instead of raw credentials. Token rotation,
deletion and explicit invalidation fan out to Host callbacks. Invalidating a
browser history scope does not delete the original shared token: if that token
remains valid it can establish a new scope, but cannot revive old bindings.
Current credential stores and revoke callbacks must both be wired by the Host.
Tabs sharing a cookie are not distinct authenticated devices/users.

`server/history-http.js` is an injected handler, not a registered production
route. It defines POST catalog (`{}`), POST registrations (`{catalogId,viewId}`),
POST page (`{bindingId,generation,requestId,page,version?}`), and DELETE registration
(`{generation}`) under `/api/history`. Every request carries the view UUID in
`X-Stepsemble-History-View`; registration body/header values must agree. Browser
requests require exact configured scheme/host/port Origin, JSON and the fixed
CSRF intent header. Mixed cookie/bearer, invalid bearer fallback, duplicate
security headers, absent/foreign Origin and caller source overrides reject.
There is no CORS or legacy cookie relay exception.

The optional authenticated catalog contains only bounded `{catalogId,label,
description}` metadata. Host `listCatalog` must apply current principal visibility;
registration independently applies source authorization. HTTP request bodies cap
at 8 KiB/1,024 chunks with a 15-second maximum deadline. Before publication the
handler reauthenticates and checks registry owner/generation/lease. Responses are
no-store and capped at 272 KiB, independently of the worker's 256 KiB page frame.
For a registration that fails before normal response completion, the handler
best-effort cancels only its original private receipt, including late results
after timeout/abort. Newer renewals and claimed reads are fenced from that cleanup.
Successful `res.end` is not rolled back and does not prove browser consumption.

`client/history-transport.ts` and `server/history-relay.js` consume decoded fetch
bytes into fixed-size buffers before fatal UTF-8/JSON validation, without trusting
Content-Length or using unbounded `response.json()`. Timeout/disconnection/abort
cancel reads; late and partial replies do not publish. The relay selects only
Host-configured dedicated peer grants and exact canonical origins, sends no
browser cookie/Origin, follows no redirect, forwards no Set-Cookie/auth challenge,
and caps active forwarding flights at 64. A separate map retains at most 64 local
principal/machine/view rows, assigning its own upstream view UUID for each scope.
Page/release must match the local owner's binding/generation, pending registration
cannot read, and remote generation transfer invalidates previous local owners.
Release becomes closing before cancelling page flights and remains closing when
cleanup is unconfirmed. Relay tests cover these boundaries alongside
stream/auth/size failures. Grant rotation, local logout and shutdown must also
remove local rows and abort streams. Unknown or idle remote handles still rely on
remote lease expiry; local removal is not actual-close evidence. The remote Host
authenticates the gateway grant, not an end-to-end downstream user identity.
Production relay mounting and browser Host selection are not installed.
The pinned SDK script separately exercises two actual loopback HTTP listeners:
relay to remote registry/worker, with distinct browser principals sharing a
caller view ID and rejection of a stolen binding. This is not a real multi-host
browser test or end-to-end downstream user delegation.
An unobserved relay source change uses the existing upstream view so remote
authorization can decide tentative replacement; rejection preserves the old local
scope. A private cancelled registration receipt only returns an unobserved local
row to pending for explicit reconciliation/expiry. It does not send a delayed
DELETE that could revoke a newer remote renewal. Observed rows still require
normal release and cannot be rolled back by old registration receipts.

## Isolated synthetic preview and current evidence

`scripts/history-preview-server.mjs /absolute/pinned/sdk.mjs` creates its own
loopback HTTP server, temporary cookie and synthetic sources. It does not mount
the owner's Claude history. Its catalog offers rich, compaction, file-history and
a 1,000-message example. `public/history-preview.html` and `client/history-view.ts`
have no production app/service-worker import. The CLI's optional fixture-change
and revoke controls affect only this isolated development instance. Revoke rotates
the synthetic cookie first and invalidates its old principal; reloading the page
obtains the new cookie. It does not touch production token/grant authority.

The viewer supports source selection, manual refresh, forward/backward paging,
cancel/close, explicit page-size choice and visible stale/error states. A new
generation cannot continue old pages; a successful refresh replaces them
atomically. Native text/tool/attachment/URL-looking content is inert text/details,
never executable HTML, active links or attachment fetches. Rendering is bounded
to 10 messages per window, 24 blocks per message and 48,000 text units, with visible
shortening indicators. Close/pagehide release is best effort; local cancellation
does not prove worker close, and Host leases remain the fallback.
Likewise server response completion does not establish browser consumption of a
registration reply. Exact-receipt rollback can handle known failed delivery;
tentative replacement and leases cover the remaining lost-reply window.

On 2026-09-08 an actual Node **22.19.0** binary on macOS arm64 passed the loader
tests and complete pinned `check-native-claude-history.mjs` contract. The latter
now calls `scripts/check-history-access.mjs` for real loopback HTTP → registry →
owned worker → official SDK → Client paging, independent views, owner transfer
and in-flight revocation. It reported synthetic POSIX fixture gates passed,
`modelCalls: 0`, unchanged native fixture bytes and no added authority. Existing
CI targets Node 22.19.0 on macOS/Linux/Windows; that configuration is not a claim
that this uncommitted batch has completed remote CI. Windows source gates remain
unsupported, even when non-source framing and SDK fixture tests pass.

An actual Computer Use pass also checked the isolated viewer at desktop and
320/390px phone viewports, paging, source changes and synthetic cookie revocation;
see [preview acceptance](../../../docs/history-preview.md). This does not replace
mobile-device, multi-client performance, rollout or production identity/source-policy
integration. POSIX ACL/descriptor containment, ancestor trust and native
provenance remain separate blockers. Node 22 provides no public `fs.openat` or
fd-based ACL API; passing an already opened file descriptor can narrow child
path grants but does not fix the parent's initial open race or cleanup/IO budget.
A reviewed native helper is required for those stronger platform gates.

Primary runtime references: [Node 22.19 synchronous hooks](https://nodejs.org/download/release/v22.19.0/docs/api/module.html#moduleregisterhooksoptions),
[descriptor inheritance](https://nodejs.org/download/release/v22.19.0/docs/api/child_process.html#optionsstdio),
[permission limitations](https://nodejs.org/download/release/v22.19.0/docs/api/permissions.html#limitations-and-known-issues).

## Owner-session evidence and remaining gates

On 2026-09-07, the same SDK read **only** the exact Claude smoke session authorized
and created on 2026-09-06. In a permission-restricted subprocess, the two existing
user/assistant rows, native session identity and fixed marker matched; the file
hash was unchanged. This was not a new model attempt. Sanitized evidence:
[`native-readback-2026-09-07.json`](../../../docs/baselines/native-readback-2026-09-07.json).

These are reader/access contracts and an isolated inert preview, not a normalized
journal import or an enabled production history feature.
Selected tool/thinking/attachment-reference and interruption/compaction mapping,
plus bounded source decoding and observed-consistency checks, now have synthetic
pinned-SDK coverage. Full attachment materialization, authenticated source
ownership/platform ACL containment, incomplete/other unscoped JSONL recovery, subagent attribution,
refusal supersession, approval decision versus native acknowledgement,
resume/reconnect, real persistence, retention and large-history performance
remain unverified. No `approval.resolved`/ACK/run-completed
fact may be manufactured from this preview. Native history remains authoritative;
future publication must use the reserved transaction/projection gates.

Sources: [official session APIs and message identities](https://platform.claude.com/docs/en/agent-sdk/typescript),
[session lifecycle](https://platform.claude.com/docs/en/agent-sdk/sessions).
The installed version's declarations/source were inspected because the current
online reference is not an immutable schema for 0.3.259.
