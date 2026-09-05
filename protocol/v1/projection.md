# Full normalized history and snapshot proposals

Plan 1.15. Reserved contract implementation, **not a live history endpoint, native
adapter, database or claim of complete native parity**. `client/projection.ts`
compiles to the same `public/modules/projection.js` used by Node and browsers.
It consumes authorized journal facts through the existing lifecycle reducers;
no code here sends commands, resolves permission prompts or accesses credentials.

## One detached state, one publication

`SessionProjection` contains a session row, all retained run/approval rows, full
normalized message/tool text, per-run usage/context, a generation-aware cursor,
last event time and a bounded duplicate-integrity window. It is not the native
transcript and does not replace the append-only journal. In particular, arbitrary
additive informational event fields and terminal run error details remain in the
journal; the projection intentionally retains only its declared view.

`applyBatch(prior, batch)` validates the entire bounded JSON input and replay
envelope, detaches both inputs before its first asynchronous digest operation,
stages every change, validates the resulting relationships, and returns one
`apply` proposal. A late bad event returns `snapshot_required` with a fixed reason
code; **none** of the staged rows or cursor escape. An entirely matching duplicate
returns `duplicate`. Unknown events, gaps, scope/generation changes, conflicting
IDs/digests, aggregate overflow and invalid transitions never advance the cursor.

All 35 variants have an explicit switch case. New variants must add implementation
and coverage; the TypeScript `never` check makes omissions compilation errors.
Session creation from an empty projection currently requires a null initial
profile reference, followed by `model.changed`. A historical session already
bound to a profile must enter through a validated Host snapshot; replay cannot
invent a profile that is not in an event. Creation/transition ordering uses the
lifecycle millisecond timestamp profile. Journal timestamps must be nondecreasing;
an adapter needs a separate original-native timestamp for unordered source facts.

Publication needs **both cursor and a local/store revision fence**. Cursor-only
CAS is insufficient: a repair snapshot may replace content at the same cursor.
`createReplica` supplies an in-memory revision fence, detached reads/results,
concurrent publication rejection and snapshot-request capture. It has no storage
or network. A caller captures `snapshotRequest(targetGeneration)` **before** its
HTTP request; an older response cannot replace a newer replay or same-cursor
repair. A rejected race must be retried from the current read, not forced through.
The future Host transaction must provide its own equivalent durable fence.

## History semantics

- `message.delta` appends to text or thinking for one assistant message. The two
  channels remain separate. `message.completed.content` **replaces** text, never
  appends a second copy, and retains known thinking. User messages are complete
  single records. IDs cannot move across runs or change roles; completed records
  are immutable except that an identical replay is skipped before reduction.
- A tool is requested, then running, then completed/failed. Progress is an append
  stream; final output is a separate authoritative field, not a concatenation of
  progress. Failure preserves progress. A tool's approval must be approved and
  natively acknowledged before execution facts can be projected; denied,
  expired, cancelled or merely decided approvals never unlock it.
- Run termination preserves unfinished message/tool text with `incomplete` and
  an explicit `terminalCause`. This means **no native final was observed**, even
  when the run reports completed. It is not fabricated completion/cancellation.
  Orphaning does not terminate partial history or release the writer. Host or
  transport recovery alone does not resume any run.
- Usage events are absolute per-run counters; each counter must not regress.
  Zero is distinct from no usage record. Cached tokens are not assumed to be a
  subset of input, nor are independent safe integers added into an unsafe total.
  A harness reporting per-turn usage must normalize it before journal admission.
- Context usage may grow or shrink. Compaction updates the known used count and
  records before/after values, retaining an existing limit or explicit `null`.
  No limit, shrinkage or `used <= limit` relationship is invented. Late usage and
  context metadata can be recorded after a run ends without reopening it.
- Connectivity remains connection-local UI state; historical transport/Host
  notices advance the journal cursor but do not claim the current connection is
  live. They never grant runtime or approval authority.

Snapshot relationships reject foreign/missing runs, duplicate entity identities,
multiple writers, mismatched active profiles, invalid time ranges, reused approval
nonces/native request identities, dangling tool approvals, unfinished records on
terminal runs, and partial records falsely labelled complete. Native identities
and evidence references still require the actual adapter/store to verify truth.

## Digests and complete replacement

`sha256-sorted-json-v1` uses UTF-8 compact JSON. Object keys sort by JavaScript
UTF-16 code units; arrays retain order; primitive escaping and finite number
formatting follow `JSON.stringify` (including negative zero as zero). It does not
normalize Unicode, truncate text, invoke `toJSON`, or accept unpaired surrogates.
This is a documented project encoding, **not a claim of general RFC 8785 support**.
Future Rust must match these vectors, including numeric-looking keys and number
formatting. Domain separation is exact:

```text
SHA-256(UTF8('["stepsemble.event.v1",' + canonicalJSON(event) + ']'))
SHA-256(UTF8('["stepsemble.snapshot.v1",' + canonicalJSON(state) + ']'))
```

`sealSnapshot` validates and detaches state before hashing. `restoreSnapshot`
requires a checksum-valid, semantically valid complete replacement from an
**authenticated, authorized Host**, the captured current cursor and an explicit
target generation. Same-generation snapshots cannot go backwards. A new
generation is never inferred from malformed data or an arbitrary stale response.
The checksum detects corruption; anyone who can alter state can recompute it, so
it is not authentication, authorization, encryption or proof of native execution.
No snapshots/receipts should be published as public assets.

The last 5,000 event identities include contiguous sequence, event ID and the
digest of the **whole event**, including additive fields. Replayed overlap checks
all three. `identityFloor` makes the retention boundary explicit; a duplicate at
or before that floor requires a snapshot instead of blindly trusting an old
sequence. Removing an identity does **not** remove any message/tool history.
Historical event-ID uniqueness outside this window belongs to the durable
journal's unique index, not to the bounded Client replica.

## Resource bounds and rollout gates

Decoded projection state is at most 32 MiB UTF-8; a replay batch is at most
16 MiB and 500 events. Limits are additional to schema bounds: 1,000 runs,
5,000 approvals, 10,000 messages/tools each, 262,144 Unicode code points per text
channel/progress/output, 5,000 retained identities. Over-capacity is an explicit
failure, never silent partial history, dropping older runs, or inferred completion.
Larger sessions need a separately negotiated, atomic paged-snapshot design before
support is advertised. Raw transport limits **before JSON parsing** remain required.
Decoded safety checks cap depth/nodes and reject cycles, shared-object graphs,
accessors, classes, holes, symbols, nonfinite numbers and non-JSON values. These
are untrusted-wire-data checks, not a sandbox for attacker-created JavaScript
Proxies. Large snapshot shape validation uses its own bounded visit budget.

Tests cover all events, every split of a full successful replay, late rollback,
duplicate tampering/overlap, no-ACK and denied approvals, partial terminals,
orphan recovery, exact Unicode boundaries, 10,000-message validation, 5,500-event
identity rollover, corrupt/foreign/stale snapshots, async input mutation and
concurrent/same-cursor publication. Node and browser-VM use identical artifacts.
These are deterministic synthetic tests, **not browser smoothness measurements**.
Full-state validation/clone work is not yet off the UI thread; integration needs
worker/paging/performance gates before it can replace the current live UI.

All eight command/maintenance/terminal receipt/entity/outbox proposals are now in
[transactions.md](transactions.md). Still required: native/evidence ingestion,
real durable admission/CAS/rollback/crash/rebuild tests; native adapters that provide these
facts; authenticated snapshot transport; rolling shipped-client compatibility.
Production 3.0.3 and its legacy HTTP/SSE behavior are unchanged.
