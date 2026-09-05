# Command receipts and idempotency — reserved reference contract

Plan 1.13. This is executable contract work for the future durable Host, **not a
live endpoint or persistence implementation**. `protocol/command-state.js` returns
proposals only. It does not write files/DB rows, acquire locks, authenticate a
device, read the current clock, call a model, send an approval or dispatch native
commands. The running legacy HTTP/SSE paths do not use it. No new capability is
advertised, and the SDK still never automatically retries side effects.

## Intent identity

Within one authoritative Host store, the idempotency scope is the four-part tuple
`[authenticatedDeviceId, sessionId, commandType, idempotencyKey]`. Do not join IDs
with an ambiguous delimiter. The supplied `deviceId` must equal the authenticated
device, and current session/device authorization is required even to replay an
old result. These checks are not replaced by possession of a receipt/key.

`sha256-tuple-v1` hashes UTF-8 bytes of compact JSON with this exact array layout:

```json
["stepsemble.command.v1",1,"device-1","session-1","session.rename",[["title","Synthetic title"]]]
```

The final array contains `[key,value]` pairs of the closed command payload, sorted
by ASCII field name. All eight current payloads contain only well-formed Unicode
strings (or no fields). JSON uses JavaScript `JSON.stringify` escaping, no spaces
and no trailing newline. There is **no Unicode normalization**, trimming or value
coercion. Unpaired surrogates and unknown intent fields/types are rejected.
Prompt limits remain 262,144 code points; encoded tuples have an additional
1 MiB + 8 KiB bound. This is not a general RFC 8785 canonicalizer. Future payload
types require a reviewed fingerprint-version rule, not a silent serializer change.

The hash includes protocol version, device, session, type and every intent field.
`commandId` is a diagnostic request identity; an otherwise identical retry may
have a new one. `idempotencyKey` is part of the lookup scope, not intent bytes.
Additive outer informational fields are ignored and must never affect execution.
`fixtures/command-fingerprints.json` freezes all eight synthetic digests; tests
also spell an independent Chinese/emoji/newline/quote/backslash/U+2028/U+2029 tuple
for a future Rust implementation to match.

Receipts keep the **original** command ID. Only that ID is indexed; new diagnostic
IDs on replay are not reserved as aliases. A key with changed intent conflicts.
A stored original command ID reused for a different operation also conflicts.
Different keys represent different operations: this is not semantic deduplication
of all similar prompts. Native writer/approval checks still apply at admission.

## Admission proposal

`inspectCommand(command, context)` requires trusted, freshly authorized Host
context, an explicit `existingReceipt` lookup by scope and an explicit
`commandIdReceipt` lookup by device/session/original command ID. Both must be a
valid row or `null`, read in the same transaction. Missing/undefined/corrupt or
contradictory lookups fail closed; they are never interpreted as a cache miss.

- Matching existing intent returns `replay` and a copy of its stored receipt in
  **any** state. It does not redo mutation preflight: the original operation may
  already have changed the run, archived the session or consumed an approval.
- A new intent runs domain preflight for active writer, profile/auth/billing,
  session state, approval nonce/scope/expiry and authenticated device. Explicit
  Host time cannot predate the session/run. It returns `admit` with revision 0,
  state `accepted`, no attempt and no outcome.
- Rejection contains only a fixed reason code, never the command/prompt or
  arbitrary native error contents.

The receipt schema is closed and bounded; it contains opaque IDs, digest, state,
revision, timestamps and an optional small outcome. There are no raw prompts,
credentials, filesystem paths or response blobs. Digests are **not anonymization**
or authorization: low-entropy input may be guessed. Keep receipts, references and
their indexes private; never derive IDs from secrets. The actual command payload
belongs in a separately bounded private durable outbox, not this receipt.

## Delivery state machine

| State | Permitted actions | Meaning |
| --- | --- | --- |
| `accepted` | `dispatch`, `reject` | Admitted, no dispatch marker committed yet |
| `dispatching` | `pipe_accepted`, `settle`, `uncertain` | Attempt recorded before external IO; actual delivery may be unknown |
| `awaiting_confirmation` | `settle`, `uncertain` | Pipe/transport accepted; native result is still unconfirmed |
| `uncertain` | `settle` | No automatic redispatch; needs verified reconciliation of the original attempt |
| `succeeded`, `failed` | None | Immutable terminal receipt; replay returns this same outcome |

`transitionReceipt` requires expected revision, explicit nondecreasing Host time
and the correct attempt ID. It returns a new record and expected revision, leaving
the loaded record untouched. Revision overflow is refused. Unknown action fields,
wrong attempts, transitions out of terminal states and redispatch from uncertain
state are rejected. A worker **must not perform IO from a proposal alone**.

A pre-dispatch rejection has a failed outcome and no evidence/result reference.
Once dispatch starts, success or failure requires an evidence reference whose
kind is `native_ack`, `authoritative_readback` or `host_commit`. The future adapter
or local transactional operation must actually verify and durably store that
evidence for the same receipt/attempt; a browser cannot supply it as authority.
The pure checker validates shape/correlation, **not the truth of external proof**.
`pipe_accepted` is never evidence. Command success means that command's effect was
confirmed, not that a coding run or model turn has finished.

## Crash versus restored backup

`recoverReceipt` requires explicit recovery source. For a verified current,
crash-consistent store, `dispatching` and `awaiting_confirmation` become `uncertain`
using CAS; accepted/terminal/uncertain records are retained without dispatch.
An acknowledgement arriving later may settle only the same verified attempt.

An imported/older backup or unknown store returns `reconciliation_required` for
**every** record. Even an old `accepted` row may predate a dispatch marker whose
external effect already happened. Never relabel a backup as a current store just
because JSON or SQLite integrity checks pass. Restored store generations require
a global execution quarantine and native/durable reconciliation, including
operations missing entirely from that backup; this row helper cannot find them.

## Required future transactional implementation

The initial start/approval composition is executable as detached Host proposals
in [transactions.md](transactions.md). It does not satisfy the durable gates below.

The storage/worker layer must enforce all of these before this contract is live:

1. One authoritative store identity/generation and current session/device grants.
2. Unique receipt ID; unique four-part idempotency scope; unique original command
   ID per device/session. Both lookup indexes read a consistent transaction view.
3. In the same admission transaction: recheck current run/approval state, reserve
   writer or consume the approval winner/nonce, append its domain event, and
   insert receipt plus bounded outbox payload. A rejected transaction does none
   of those operations. Two devices with different keys still share the same
   approval/writer constraint; receipt-key uniqueness alone does not protect it.
4. Before dispatch: verify current grants/authority and CAS accepted revision to
   one owned attempt, commit the marker, **then** perform the external effect.
   CAS failure must never dispatch. Grant expiry/revocation before dispatch can
   be a pre-dispatch rejection; it does not imply native cancellation afterwards.
5. Verify evidence, update receipt with CAS, and append the corresponding domain
   event atomically. A stale worker cannot overwrite recovery or another result.
6. Fail closed on full/unavailable storage. Do not evict active/uncertain receipts
   or expire keys into fresh admissions. Future retention needs tombstones and a
   defined deduplication window; no automatic expiry exists in this contract.

There is an unavoidable crash window between a committed dispatch marker and
external IO. Without a native idempotency key or authoritative readback, exactly
once execution cannot be promised. Pi UI's current `{sent:true}` has no correlated
native acknowledgement; that transport cannot manufacture terminal proof here.
Restoring or retrying an unknown effect requires explicit verified reconciliation,
not a new key, automatic retry or a guess that the command was never sent.

## Evidence and remaining work

`test/command-state.test.js` exercises all eight command bindings, 30 lifecycle
state/action pairs, competing simulated insert/CAS proposals, replay after a
consumed approval, corrupted indexes, stale workers, backup quarantine and
Unicode/byte/revision boundaries. The transaction model is in-memory test code,
not proof of database locking, power-loss safety or real multi-client atomicity.

`commandReceipt` shape cases are compared independently with Ajv and the shared
Node/browser validator; semantic cases additionally run in Node, generated browser
code and typed SDK parsing. No accounts/native calls or browser visual changes
are involved. Plan 1.14 adds pure [entity lifecycle reducers](lifecycle.md), not
durable transactions. The actual store/outbox, receipt/entity atomic integration,
full projection/generation snapshots, evidence verification and shipped-client
rolling matrix remain Phase 1/5 work. Do not advertise durable idempotency yet.
