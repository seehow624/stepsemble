# Protocol v1 — incremental migration contracts

The canonical machine-readable definitions are in `schema.json` (JSON Schema
2020-12). `fixtures/negotiation.json` freezes sanitized, isolated Node wire
responses. The HTTP contract tests replay these against a real server and can
be reused by a future Rust server. No fixture contains native account data.

Currently implemented: authenticated `POST /api/protocol/handshake`, protocol
range and capability negotiation, typed client request/error handling, shared
schema and pure domain validation, and UI connection-time negotiation. The host advertises only
`legacy.http`, `pi.native-rpc`, and `agent.terminal-v1`. Domain definitions for
session/run/approval/profile/event/cursor/commands/command receipts are **reserved**, not live
endpoints or promises of durable behavior. Legacy HTTP/RPC wire formats remain
compatible in shape; native Pi malformed frames and UI replies now fail
explicitly rather than being coerced or silently ignored. See the separate
[native Pi contract](../native/pi/README.md). Existing peers need not implement
the new handshake. The UI coalesces
negotiation per host, caches successful results for 60 seconds, times out after
10 seconds, invalidates on authentication failure/sign-in view, and isolates
one caller's cancellation from other callers. Only 404 permits legacy fallback;
missing `legacy.http` capability, malformed responses, 401/403/426 and transport
errors block that request. This is capability compatibility, not authentication.

## Shared shape validation

`protocol/validator.js` implements only the JSON Schema vocabulary used here;
unsupported keywords, formats or external references fail during construction.
It is **not** a general-purpose JSON Schema 2020-12 engine. Date-time uses an
explicit-offset RFC3339 profile, rejects impossible calendar dates and leap
seconds; integers must be JavaScript-safe. Reversed negotiation ranges and
inconsistent negotiated capability sets are additional semantic checks.

`npm run build:protocol` generates `public/modules/protocol-contracts.js` and
`client/protocol-types.d.ts` from the canonical schema. The former includes
the shared validator and pure domain checks; `check:protocol` gates CI and
release artifacts. Node and browser run the same sanitized fixtures in
`fixtures/domains.json`, including mutations for missing required fields,
invalid scopes/states, timestamps and unsafe sequences. Typed `parse()` covers
nativeReference/session/run/approval/launchProfile/event/cursor/command/commandReceipt/page/replayBatch.

The closed unions define **35 event variants and 8 command variants**.
`fixtures/wire.json` supplies explicit synthetic examples for every variant;
`fixtures/corpus.cjs` adds negative/boundary cases. Unknown variants fail closed.
Events require a journal generation. Commands require a protocol version and
device ID; payloads reject unrecognized intent fields. Every event has a session
scope: transport/host notices describe that session's view, not a global journal.
Deltas allow 65,536 Unicode code points, completed text 262,144, and replay batches
500 events. Byte bounds are an additional future transport responsibility.

`npm run check:protocol:conformance` compares the corpus independently with
Ajv 8.20.0 (Draft 2020-12, full date-time formats), currently 1,179 cases. CI runs this on all three
desktop OSes and before release. Its pinned dependency lock is under
`scripts/protocol-conformance`; installation happens in a disposable local
temporary directory, with install scripts disabled. The deployed app still
needs no npm dependencies. This validates our declared vocabulary/corpus, not
every possible JSON Schema document or application invariant.

## Pure semantic and replay checks

`protocol/domain.js` exports a shared factory for Node and browsers:

- `checkEvent`: verifies nested session/run ownership, expected initial state,
  approval request timestamps and profile consistency.
- `checkProfile`: makes auth/billing combinations explicit. This initial profile
  requires native subscriptions to leave credentialReference null; native auth
  remains harness-owned. It neither imports credentials nor discovers models.
- `checkCommandContext`: requires an explicit active/terminal run or `null`,
  authenticating device identity supplied by the Host (never trusted from the
  command alone), and relevant profile/approval records. It rejects active-writer
  replacement, mid-run model changes, stale/non-pending approval, changed nonce
  or scope, foreign entities, and expiry at or before the supplied Host time.
- `checkReceipt`: checks closed receipt shape, timestamp ordering, revision,
  attempt and terminal outcome/evidence consistency. It validates an evidence
  reference, not the truth of the referenced acknowledgement or readback.
- `checkReplayBatch` and `inspectReplay`: require one session/generation and
  contiguous sequences. Full/partial duplicate delivery is filtered against a
  committed cursor; gaps, generation changes, unknown events and conflicting IDs
  inside a batch require a snapshot. The whole batch is checked before returning
  any events. Empty batches cannot claim `hasMore`, preventing retry loops.

These functions **do not persist, authorize, dispatch or approve anything**.
Approval checks must run inside the future durable Host transaction with the
winner/nonce/idempotency record. Native acknowledgement is separate from accepting
a decision (`nativeAcknowledged: false` is not native success). Replay results
must be committed with the projection before advancing the cursor. Across-batch
event ID uniqueness, payload integrity and prior-run ID uniqueness belong to the
journal store. Snapshot/restore must establish generation explicitly; never
force a stale cursor to zero silently. Receipt transition/recovery proposals are
specified below; entity lifecycle reducers are also implemented as pure proposals.
Real multi-row transactions, full projections and durable crash recovery remain
unimplemented. External exactly-once effects cannot
be promised when a provider lacks a deduplication/reconciliation primitive.

Generated TypeScript unions narrow payloads by `event.type` or `command.type`;
compile-only assertions in `client/contract-type-tests.ts` exercise this. SDK
`parse()` uses semantic checks for events, profiles, receipts and replay batches. None of
these reserved domains have replaced the legacy UI transport.

## Reserved command receipt reference

[`command-state.md`](command-state.md) specifies the Host-only pure helpers in
`protocol/command-state.js`: deterministic command binding, admission/replay,
revision-checked transitions and recovery proposals. All eight command digests
have frozen fixtures; six states and five actions have a complete 30-case matrix.
Replays require fresh trusted authorization and explicit consistent indexed
reads, but do not rerun mutation preflight against already-consumed approvals.

This is **not a durable ledger or dispatcher**. A returned proposal cannot grant
permission to perform an effect. Future atomic admission must bind the domain
mutation, approval winner, receipt, event and outbox; dispatch needs a committed
CAS plus rechecked grants. Pipe acceptance is not native acknowledgement.
Uncertain attempts never automatically redispatch, and restored/unknown store
origins require reconciliation even if a receipt still says `accepted`. The
in-memory competing-proposal tests are not storage or crash-durability proof.
No live endpoint, advertised capability or automatic SDK retry is added.

## Reserved entity lifecycle reducers

[`lifecycle.md`](lifecycle.md) specifies strict TypeScript reducers in
`client/lifecycle.ts`. Node and browser evaluate the same generated artifact.
The canonical `sessionState`, `runState` and `approvalState` wrappers add revisions,
time/profile/winner/acknowledgement metadata; use the lifecycle factory's semantic
checks/reducers, not the existing SDK's `parse()` for these new wrapper types.

Session archive/restore binds the exact archive identity. Active and orphaned
writers block replacements. Run profiles stay immutable, terminal runs cannot
revive, and a stop intent survives reconciliation. Approval resolution records a
device and receipt, separately from native acknowledgement and explicit runtime
resume. Pending approvals must receive cancellation/expiry facts before a run
can become terminal. Unsupported facts fail; no event is silently cursor-skipped.

Six reserved facts extend the earlier 29-event union: `session.restored`,
`run.stopping`, `run.orphaned`, `run.resumed`, `run.reconciled`, and
`approval.acknowledged`. Resolution additionally requires its receipt ID. This
tightens unadvertised domains only; the live handshake stays at schema 1.0.0.

These reducers require already-authorized, ordered journal facts and explicit
related reads. They do not verify native proof, enforce database uniqueness,
commit transactions or advance a journal cursor. The 10 session / 90 run / 20
approval transition cases and in-memory competing-winner model do not prove
durability. The artifact is not wired into the legacy Host or UI.

## Compatibility policy

- Clients ignore additive informational object fields; command intent payloads
  are closed and require a capability/versioned change to expand safely.
  Missing required fields or incompatible
  versions fail explicitly. A missing handshake endpoint (404) identifies an old
  host; 401, transport failures and 426 must never silently downgrade.
- v1 selects the highest mutually implemented version (currently only 1).
  Disjoint ranges return 426; reversed/fractional/unsafe ranges return 400.
- Schema patch/minor revisions may add optional fields or event types. Removing
  fields or changing semantics requires a new protocol major. Supporting the
  previous two shipped Client releases remains a release-matrix requirement;
  it has not yet been demonstrated by this initial contract.
- Reserved, unadvertised domains may still be tightened before first release.
  This slice is such a tightening, not a compatible change to an already-shipped
  journal API; the live handshake schema version stays 1.0.0.
- IDs are opaque, case-sensitive ASCII identifiers up to 128 characters, scoped
  by their entity. Do not derive identity from display names or expose local
  paths as stable IDs. Native references remain Host-local when sensitive.
- Future sequence numbers are positive safe integers per session; cursors also
  carry journal generation so Host replacement cannot silently reuse a cursor.
  Expired cursors require explicit resynchronization and a snapshot. This is not
  implemented on legacy SSE, whose limits remain documented in the inventory.
- Future retryable commands require an idempotency key scoped by authenticated
  device + session + command type. Reuse with a different payload is a conflict.
  The SDK currently performs no automatic retry of any side-effect request.
- Unknown event types must not produce a fabricated message or approval result.
  This consumer requires resynchronization on unknown events; it does not skip
  them and advance the cursor. Forward-compatible informational events need an
  explicit negotiated policy before shipping.
- Approval scope and expiry are mandatory. No default approval is implied by a
  missing/unknown capability. Native credentials must never enter an envelope.

`client/client.ts` builds to the checked-in `public/modules/client-sdk.js` using
`npm run build:client`; `npm run check:client` checks strict types and artifact
identity. The compiler is pinned to TypeScript 7.0.2; npm cache and intermediate
output are local temporary files. The deployed PWA needs neither npm install
nor a compiler. Runtime request cancellation and existing auth UI are preserved.

An initial native Pi 0.84.2 offline transcript now captures 57 frames, dialogs
and persisted-session resume; native streaming/tools/version/OS coverage remains
partial. The live legacy Host's pending-dialog reconnect snapshot is in-memory,
not the reserved generation-aware journal transport above.

Still required for the full Phase 1 gate: remaining native Pi coverage,
receipt/entity multi-row transaction integration, full message/tool/usage/context
projections, durable admission/idempotency storage and transport snapshot/cursor
recovery contracts, and the rolling
Client compatibility matrix. Do not mark Phase 1 complete from this slice.
