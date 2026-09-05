# Entity lifecycle reducers — reserved reference contract

Plan 1.14. `client/lifecycle.ts` implements strict TypeScript **pure entity
reducers**, compiled to `public/modules/lifecycle.js`. Node uses that artifact's
CommonJS export; browsers use `StepsembleLifecycle`. Both run identical fixtures.
The artifact is not loaded by the legacy UI or any Host route. No new capability,
live endpoint, database, model call, credential access or automatic retry is added.

These reducers consume **already-authorized, normalized journal facts**. They do
not authenticate requests, establish runtime liveness, verify native proof or
execute an approval. A client-supplied event is never authoritative. The Host
command path still needs fresh grants, command preflight, receipt binding and a
durable transaction; see [command-state.md](command-state.md).

## API and row contract

```js
const lifecycle = StepsembleLifecycle.create(contracts);
// contracts supplies validate(), checkEvent() and checkProfile().
const proposal = lifecycle.reduceRun(priorRun, event, {
  expectedRevision: priorRun.revision,
  session: currentSession,
  writer: currentWriter,
  unsettledApprovals: completeUnsettledRows,
});
```

`checkSession`, `checkRun`, `checkApproval` validate materialized row semantics.
`reduceSession`, `reduceRun`, `reduceApproval` return either a fixed-code rejection
or `{kind:"transition", expectedRevision, state}`. Inputs are never mutated.
Creation requires an explicit `null` prior and expected revision; existing rows
require the exact safe revision. A transition increments it once; overflow fails.
This is a **CAS precondition proposal**, not a committed mutation.

Three closed wrapper schemas are canonical:

| Row | Materialized metadata |
| --- | --- |
| `sessionState` | Original session identity, title, archive identity, current launch profile, revision/time |
| `runState` | Run identity/state, immutable profile snapshot/lock, observed native run identity, start/stop/finish times, recovery reason, revision/time |
| `approvalState` | Original request/nonce/scope/expiry, decision time/device/receipt, optional correlated acknowledgement, cancellation/expiry reason, revision/time |

Run outcomes, stop reasons and native proof events remain in the journal; these
rows are not complete conversation/history projections. The existing SDK's
`parse()` does not claim to parse these wrappers: use this factory's semantic
checks/reducers. Shared schema declarations provide their TypeScript types.

Each decoded row or lifecycle event has a 64 KiB UTF-8 bound, 8,192 visited nodes
and 64 nested edges. Non-JSON graphs, cycles, aliases, non-finite values, accessors
and non-data objects are rejected before cloning. This is not an OS sandbox;
untrusted executable JavaScript/Proxy objects are not a wire format. The future
transport must enforce byte caps **before** JSON parsing as well.

Lifecycle time comparisons have millisecond precision. Explicit RFC3339 offsets
are accepted, but fractions finer than milliseconds are rejected rather than
truncated. New row update/observation times normalize to UTC milliseconds. The
Host supplies nondecreasing logical journal time; replay uses the event's original
time, never today's clock. Initial entity creation facts align their creation and
event times; native historical imports need the future explicit snapshot/import
contract, not an invented sequence of fresh creation events.

## Related reads are part of the future transaction

Every reducer validates the scope and time of its related rows. Run changes also
require the exact current writer row (including revision/content); terminal runs
require no active writer. `orphaned` still owns that slot. Session mutations that
need no writer require an explicit `null`, not an omitted lookup.

Run context must contain the **complete** unsettled-approval read for that run:
pending rows plus approved/denied rows with no native acknowledgement. Terminal
cancelled/expired/acknowledged rows are not part of this read. Missing, duplicate,
foreign or malformed rows fail; the context has a hard 128-row cap. New approvals
are refused at 32 unsettled rows. No reducer evicts a record to make room.

New run identity, new approval identity and nonce availability require explicit
trusted index-read results. They are not booleans a browser may assert. Durable
constraints must reserve IDs/nonces across completed and historical records;
checking current rows alone cannot prevent reuse. Active native-request aliases
are rejected even when supplied with different approval IDs/nonces.

## Session transitions

- `session.created`: explicit nonexistence, no writer, matching optional profile;
  preserves stable native/workspace identity. An existing row cannot be recreated.
- `session.updated`: update title only while active; a running writer is allowed.
- `session.archived`: active and no writer; retain archive ID, title and profile.
- `session.restored`: archived, no writer and the **exact** archive ID; clear only
  the archive identity/status. A stale restore cannot target a later archive.
- `model.changed`: active and no writer; validate harness/auth/billing. A changed
  model needs a new profile identity. Known source/auth/billing/credential-reference
  changes require a fork rather than an in-place replacement. The current profile
  schema does not yet represent every provider/protocol/router dimension; full
  Model Source compatibility remains Phase 7, not a guarantee from these fields.

## Run transitions

| Current state | Permitted facts |
| --- | --- |
| Absent | `run.starting`, with unused identity, no writer and a session profile |
| `starting` | Lock the exact profile once; start only after lock; stop, orphan, fail or interrupt |
| `running` | Request approval; stop, orphan, complete, fail or interrupt |
| `waiting_approval` | Additional approval; explicit verified resume, stop, orphan or terminal outcome |
| `stopping` | Orphan or terminal outcome; never restart/resume |
| `orphaned` | Explicit reconciliation or terminal outcome; still blocks new writer/model/archive |
| `completed`, `failed`, `interrupted` | None; late starts cannot resurrect a terminal run |

`run.starting` captures the current profile by value. `launch_profile.locked`
must match it; no mid-run rewrite is permitted. An unstarted run may fail or be
interrupted, but cannot claim successful completion. A completed run can never
be reused as a new run; the identity index belongs to the future store.

`approval.requested` needs **both** a new approval row and a run transition to
`waiting_approval` from the same event, in one transaction. `run.stopping` records
intent, not successful cancellation; it does not silently discard approvals.
Pending approvals must get explicit cancellation/expiry events before a terminal
run outcome is committed. Approved/denied but unacknowledged decisions may remain
uncertain even when a run ends; do not manufacture a delivery receipt success.

`run.resumed` requires no unsettled approvals and a native evidence reference.
Resolving or acknowledging an approval does not itself change run state. For
parallel tools, this first contract conservatively keeps the run waiting until
the entire unsettled set is clear; per-tool concurrency is a later projection
contract, not inferred from these rows.

`run.orphaned` is **nonterminal execution uncertainty**, not proof a process died.
`run.reconciled` needs native evidence and the same known native run identity. It
can resume running only with no unsettled approvals, or waiting only with at least
one. A prior stop intent cannot be erased: reconciliation must preserve stopping.
If the profile was never locked, fail closed rather than guessing a live process.
Transport reconnect/Host ready events cannot substitute for liveness evidence.

## Approval decision versus delivery

1. `approval.requested` creates pending, revision 0, with an unused identity/nonce,
   a running/waiting run and a live expiry at the event time.
2. `approval.resolved` consumes a pending row exactly once at the reducer level.
   It requires the correct nonce and a waiting run, rejects time at or after expiry,
   and saves decision, device and **resolution receipt ID**. Its legacy
   `nativeAcknowledged` field must be false in this lifecycle contract.
3. `approval.acknowledged` is separate: the original approval/nonce/receipt must
   match, and the event names the delivery attempt and a `native_ack` or
   `authoritative_readback` reference. A second acknowledgement cannot replace it.
   A late verified acknowledgement can enrich a decided row after run termination;
   it never revives the run or changes the user's decision.
4. Pending expiry/cancellation creates a terminal row with no winner/receipt/ACK.
   Expiry is valid at or after the deadline, never before. Neither implies approval.

The reducer validates proof **shape and recorded identity**, not whether a native
system actually emitted it. Before appending an acknowledgement/resume/reconciled
fact, the future Host adapter must verify the receipt, exact attempt, decision,
native incarnation and evidence, and save that proof durably. Pi's current
`{sent:true}` pipe response provides none of this evidence. Do not synthesize it.

## Atomic transaction requirements

These are mandatory store gates, not functionality supplied by a reducer:

| Transaction | Indivisible changes and required checks |
| --- | --- |
| Start | Fresh grants + receipt/key/ID admission, session revision/profile read, unique writer reservation, new run + lock facts/rows, receipt + bounded outbox |
| Approval request | Native request/nonce uniqueness, current writer and capacity read, new approval row + waiting run row, one journal fact |
| User decision | Fresh device/session grants, command fingerprint/nonce/scope/expiry, CAS pending winner + related run/session revisions, receipt + event + outbox |
| Stop/terminal | CAS writer/run; append cancellation/expiry facts and update all pending approvals before terminal fact; release writer only at verified terminal outcome |
| Native acknowledgement | Verify the original receipt/attempt/evidence; CAS receipt + approval result; append fact and persist proof together |
| Archive/model/restore | Fresh grants and receipt, current session CAS + no-writer constraint, native/local effect contract and rollback/reconciliation as applicable |

Check all read versions and uniqueness constraints again at commit. A stale or
failed transaction writes **none** of its rows/events/outbox. One-row CAS is not
enough: simultaneous start/archive, approval/stop and two-device decisions need
the shared constraints. Native/local filesystem effects cannot be rolled back by
pretending they were inside SQLite; their dispatch/reconciliation uses receipts.

During journal replay, grants are not reevaluated against historical facts, but
event ordering/generation/identity must be verified before these reducers run.
Per-entity revision is not the journal cursor. Batch staging, full projections and
cursor advancement must commit together; these functions do not deduplicate or
advance a cursor, and must not silently ignore an unsupported event.

Backup/unknown-generation recovery stays quarantined as specified by the receipt
contract. Loading valid rows does not establish current store authority or detect
operations omitted from an old backup. No automatic native action follows replay.

## Evidence and remaining gates

`test/lifecycle.test.js` covers the complete 10-case session matrix, 90 run cases
(eight run states plus locked/unlocked starting), 20 approval cases, full normal
lifecycle, stop/cancel/late-ACK, orphan barriers, cross-row corruption, identity,
revision, time and graph/byte bounds. Node and browser use the same generated code.
Independent Ajv conformance checks declared shapes, while reducer fixtures check
additional semantic invariants. A competing in-memory transaction model commits
one decision/receipt/event or none; it is **not database concurrency evidence**.

Remaining: the actual multi-row transaction builder/storage/CAS, durable journal
and outbox, native proof verification, message/tool/usage/context projections,
generation/cursor snapshot and atomic full-batch recovery, real crash/power-loss
tests, native adapter parity and rolling shipped-client compatibility. Do not
mark Phase 1 or durable session/approval support complete from these reducers.
