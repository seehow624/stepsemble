# Receipt/entity/outbox transaction proposals

Plan 1.17. `protocol/transaction-state.js` is a Host-only **reference transaction
planner**, not a database or native dispatcher. It composes existing receipt
contracts and the complete projection reducer over one detached, consistent
session view. None of its results imply an operation was persisted or sent.

## Implemented scope

The first native-effect integration covers `run.start` and `approval.resolve`,
dispatch-marker/pipe-acceptance transitions, correlated approval acknowledgement,
current-store versus backup recovery, normal run-start confirmation, verified
non-application failure, pre-dispatch rejection/starting-writer cleanup, and
uncertain-delivery/orphan proposals. Other six command transaction builders,
terminal/cancellation and maintenance reservations are **not implemented here
yet**. Unsupported builders reject explicitly; no live endpoint uses this
module and no new protocol capability is advertised.

`initialView` accepts an already validated, nonempty session projection plus
opaque store identity/generation. The view includes a store revision, explicit
quarantine flag, complete receipts and their private outbox entries. This is a
trusted store read model, never a JSON body accepted as authority from a Client.
Imported runs can exist without a Stepsemble start receipt, but every retained
Stepsemble approval decision must have its corresponding winner receipt/outbox.

`checkView` verifies full projection relationships plus receipt ID, idempotency
scope, original command ID, attempt ID and command-target uniqueness. Every
receipt has exactly one outbox entry containing only the known command fields;
the fingerprint, command/receipt identity, run/profile or approval winner must
match. It rejects dangling decisions, orphaned receipts, altered intent,
unacknowledged success, mismatched evidence/attempt and invalid private rows.
The view is bounded at 64 MiB and 5,000 receipts/outbox rows; it never evicts active
or uncertain work to admit another command. The projection has its own stricter
bounds. Prompts belong only in the private outbox, not receipts or diagnostics.

## Atomic proposed operations

| Planner | Indivisible proposed changes |
| --- | --- |
| `planAdmission(run.start)` | Fresh authorization/preflight, unused run ID, capture and lock existing session profile, reserve starting writer, two journal events, accepted receipt and exact bounded private outbox |
| `planAdmission(approval.resolve)` | Fresh authorization, pending run/approval/nonce/scope/expiry checks, one decision winner, one journal event, accepted receipt and private outbox; no native ACK or automatic resume |
| `planDispatch` | Recheck grants/device, quarantine, run state and approval expiry; CAS receipt revision into a unique attempt bound to an explicit native incarnation; no IO |
| `planPipeAccepted` | Same attempt/incarnation, receipt to awaiting confirmation; no approval/run mutation |
| `planApprovalAcknowledgement` | Trusted verified evidence for exact native request/nonce/attempt/incarnation; succeeded receipt plus approval ACK row plus one event; no automatic run resume |
| `planRunStartAcknowledgement` | Correlated native start proof; succeeded receipt plus run.started if still starting; never confuses command success with completed coding turn |
| `planRejectBeforeDispatch` | Current, non-quarantined store's accepted receipt becomes failed; an unsent starting/orphaned writer becomes failed atomically; retain receipt/outbox for idempotent replay |
| `planNativeFailure` | Verified exact attempt was not applied; failed receipt plus failed unstarted run where appropriate; no guessed outcome after a transport failure |
| `planDeliveryUncertain` | Same attempt/incarnation goes uncertain; retain orphaned writer and private command; no resend |
| `planRecovery(current_store)` | In-flight receipts become uncertain and nonterminal writer becomes orphaned; retain writer and partial history; no redispatch |
| `planRecovery(restored_backup/unknown)` | Quarantine entire view even if all old receipts say accepted; no implicit unquarantine or new native effect |

Existing-key replay still requires fresh access, but returns the original receipt
before mutation preflight. It does not create diagnostic-ID aliases or an outbox
for a retry. Read-only replay remains possible in quarantine; it does not clear
quarantine or authorize dispatch. New command keys still compete for the same
writer/approval winner, including across devices. A new start uses the already
selected session profile; it does not silently perform an unrequested model or
credential-route change.

All synchronous reads are detached before the first asynchronous projection hash.
Results contain `expected {storeId, storeGeneration, revision, cursor}`, a complete
next view with revision + 1, events to append and an optional receipt ID. Caller
mutation during hashing cannot change the captured read set or private command.
An invalid final event leaves no returned partial receipt, outbox, winner or
cursor. Concurrent proposals may both be locally valid; **only one may commit**.

## Mandatory real store/adapter gates

The future durable store must, in one transaction:

1. Read authoritative identity/generation, current device/session grants and
   every affected entity/index, including all writers and pending approvals.
2. Build a proposal from that consistent read; recheck the complete expected
   store revision/cursor and unique constraints at commit. Authorization is not
   a historical boolean that can be reused after revocation. If grants use a
   separate revision, it is another required transaction dependency.
3. Atomically persist rows, append-only events, cursor, private outbox and any
   verified proof. A rollback/CAS failure writes none of them. The in-memory view
   only models one session; shared device grants and global IDs/indexes need
   actual store-wide constraints.
4. Before native IO, commit the single owned dispatch marker. A proposal cannot
   be dispatched. Workers must verify native incarnation/authority and handle
   ambiguity after commit without automatic retries or assumed exactly-once IO.
5. Verify actual native proof against the original request/attempt/incarnation,
   then record it with the receipt/domain transition. `evidenceVerified: true`
   is a trusted adapter assertion in these tests, **not a proof service or an
   HTTP permission field**. Pipe acceptance is not evidence.

Native acknowledgement is a delivery fact even after device access was revoked
or the run ended. Recording an already verified effect must not erase history or
revive the writer; it does not grant new execution rights. Backup reconciliation
may record such evidence but keeps the global quarantine in place. Rotating
generations, identifying operations omitted from old backups and eventually
clearing quarantine need a separate audited store-level recovery procedure.

## Start/failure and late evidence

A normal start ACK confirms the command's startup effect, **not** completion of
the coding run. If native startup was already recorded and the same native ID is
known, a delayed receipt ACK can settle without another run event, including
after the run ended. If no startup was ever recorded and the run is now stopping,
orphaned or terminal, an old startup ACK is not fresh liveness/history proof:
the planner requires reconciliation and does not turn the run back to running.
The future adapter must import/reconcile authoritative timing/state for that gap.

Pre-dispatch rejection requires an explicit `current_store` source and a view
that is not quarantined. Once an attempt marker exists, the operation cannot be
relabeled definitely unsent. A verified current-store accepted row can be rejected
after grant revocation without native execution; its unstarted writer is released
with a run-failure fact, but the original failed receipt remains replayable. A
different explicit user command can start a new run; the rejected key cannot.

A native failure planner requires verified `not_applied` evidence for the exact
attempt/incarnation and run or approval request/nonce. Model errors *after* a
known startup are not failures of the original start command. Unknown effects
instead retain an uncertain receipt and orphaned writer. Approval delivery
failure does not reverse the recorded user decision, fabricate native ACK or
automatically resume; the failed delivery remains visible through its receipt.

## Evidence and remaining work

`test/transaction-state.test.js` covers detached start admission, two-device
writer/winner races with different keys, retry replay after the state changed,
malformed/colliding late events, corrupt receipt/outbox relations, competing
dispatch attempts, pipe versus native ACK, wrong nonce/request/incarnation/proof,
late terminal ACK, current-store uncertain/orphaned recovery, backup quarantine
async caller mutation, normal/late start ACK, unsent-writer cleanup, retained
failed-key replay, verified non-application versus uncertainty and rollback of
stale/malformed cleanup. The commit model checks the full expected view token;
it is deliberately **not SQL concurrency, fsync, power-loss or native evidence**.

Next: complete the remaining command/effect builders and fixtures, then integrate
an actual durable store according to the accepted phase gates, including bounded
outbox retention/tombstones, journal uniqueness beyond the Client window, proof
storage, rebuild, crash/backup drills and live adapter/transport compatibility.
