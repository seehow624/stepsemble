# Reserved inert-history Client view

Plan 1.40 controller / Plan 1.41 shared provider. `client/history-pages.ts` builds `public/modules/history-pages.js`.
This is a transport-neutral state controller, **not a deployed history screen,
Stepsemble Protocol wire endpoint, authenticated source registry or journal**.
Production HTML, service worker, login, models and routes do not import it.

## Required integration boundary

`StepsembleHistoryPages.create()` requires four trusted dependencies:

- `read(scope, request, {page, version?, signal})`: a scoped transport returning
  an already-decoded value. It must enforce a raw byte limit **before parsing**,
  authenticated Host/device access, binding ownership and cleanup semantics.
- `canonicalJSON(value, maxBytes)`: reviewed bounded JSON-only serializer, with
  no accessors/toJSON, cycles or invalid Unicode. The existing projection helper
  is used in tests; this is not a defense against arbitrary executable Proxies.
- `validateHistory(history, sessionId, page)`: complete provider-specific shape,
  limits, supported reader/hash, message/tool/auxiliary and authority validation.
  It is mandatory, pure and synchronous; only the boolean `true` is accepted,
  not a Promise/truthy value. `() => true` is not a valid real integration.
- `requestId()`: a UUID generator, independent of model/session creation.

The controller checks the outer bound reply/correlation, session/page identity
and all-false authority itself. It then invokes the provider validator on a
detached JSON value. The shared Claude provider now supplies this validator
directly, without a private worker-wire bridge. Authenticated transport, source
registration and authorization remain unimplemented. Do not attach the reserved
module to production by substituting a permissive validator.

### Shared browser-safe provider (Plan 1.41)

`client/claude-history-value.ts` contains the reviewed observation shape checks;
`client/claude-history.ts` contains the whole provider envelope and fixed reader
profile. Both build into `public/modules/`. The Host worker wire calls the same
`validHistoryValue` predicate after its existing byte-bounded, detached decoding;
`history-observation-value.js` is a compatibility export, not a second validator.
SDK loading reads the same pinned reader constants but stays in the Node-only
`history-sdk.js`; neither browser module imports an SDK, filesystem, network,
credential, source file or native CLI.

Load `projection.js`, `claude-history-value.js`, `claude-history.js` and
`history-pages.js` in this order for the standalone browser namespaces. In Node,
the generated CommonJS exports load only the value module dependency. Construct
`StepsembleClaudeHistory.create({canonicalJSON: StepsembleProjection.canonicalJSON})`
and pass its `validateHistory` to the page controller. These scripts are not
added to production HTML/service-worker precache by this batch.

- `parseHistory(value, sessionId, page)` validates and returns a detached provider
  history value or null; `validateHistory` returns a synchronous boolean.
- `decodeHistory(bytes, sessionId, page)` checks a nonempty Uint8Array's raw size
  **before parsing**, rejects BOM/invalid UTF-8/malformed or multiple JSON values,
  then uses the same bounded JSON/value checks. The input buffer is copied.
- Decode accepts exactly the inner `source_history_observation` JSON payload,
  not a private worker JSONL frame or a bound HTTP response. The future transport
  still needs a streaming raw limit for that outer response **before collecting
  and parsing it**. Supplying an oversized buffer here cannot undo earlier
  unbounded transport allocation.
- The low-level `validHistoryValue` and `validObservation` predicates assume
  bounded detached JSON. They are not raw JavaScript accessor/Proxy defenses.
  Public parse/decode uses the mandatory reviewed canonical JSON helper.
- All source/observation authority stays false. Digests are structurally checked,
  not proven against a native file by a browser. Tool/ancillary data remains
  inert, page-scoped; validation does not execute/fetch attached content.

Incorrect asynchronous validators are rejected by the controller; a native
Promise's rejection is absorbed to avoid an unhandled error. This does not make
async validation supported or delay the commit pending a Promise.

## State and operations

The scope is exactly `{hostId, bindingId, generation, sessionId}`. No native file
path, credential or SDK selection comes from this view. `reset(scope)` validates
and copies it, aborts the pending read and clears old pages. `dispose()` also
clears everything and is irreversible. Neither operation starts a read.

| Operation | Result and invariant |
| --- | --- |
| `refresh({offset,limit})` | Supersedes/aborts an older read. Sends no version; successful validation replaces the whole view atomically. Failure/cancel leaves the old pages/token visible. |
| `loadNext(limit)` | Requests the next contiguous SDK offset with the established token. A short/empty response marks end; an empty continuation is not retained as another page. |
| `loadPrevious(limit)` | Requests a preceding contiguous interval, clamped to offset zero. A short result is a gap and is rejected. |
| `cancel()` | Clears the local ticket before sending its abort signal; late results cannot publish. This is **not confirmation of Host worker exit**. |
| `state()` | Returns a detached view with status/error, source version, page-scoped observations, counts/offsets and end marker. It never grants execution authority. |

There is one in-flight read per controller, no queue, polling, automatic retry,
prefetch or automatic fallback. Repeated continuation while busy is rejected.
An explicit refresh can supersede it; callers must handle a Host `source_busy`
while the earlier worker is still closing. Aborting a view does not bypass the
Host's two-worker admission or quarantine/cleanup rules.

After each asynchronous read, ticket **object identity** is checked before
decoding/validation. Resetting Host, session, binding or generation; refreshing;
cancelling; or disposal fences old results even if a request UUID is reused.
An old completion cannot clear a newer pending ticket.

## Assembly and retention

Append/prepend requires the same opaque source token, complete source summary
(including raw SHA and filesystem identity), reader profile and whole-source
canonical digest. SDK ordering is retained; there is no timestamp sorting,
message-ID deduplication, API-ID merge or silent partial acceptance. Duplicate
native UUIDs reject the incoming page. Tools, auxiliary evidence and warnings
stay **page-scoped**: a request/result on different pages is not upgraded into
an approval ACK, terminal event or resume permission.

Limits are 100 messages/page, offset 0–2000, 272 KiB decoded outer reply, 500
retained messages, 32 retained pages and 2 MiB canonical retained page bytes.
The Claude provider wire has its own tighter 256 KiB frame limit. Every incoming
page/view is checked before commit. Exceeding retention limits keeps the existing
view unchanged; an explicit refresh to another window is required. No eviction,
unbounded cursor cache, raw native-record cache or persistence is introduced.

Observed source-version changes/unavailability, binding revocation, service
shutdown/quarantine or unconfirmed cleanup make the retained view `stale` and
block continuation until explicit refresh. Old pages may remain visible, but
must be presented as stale; they are not current native state. Unknown failure
codes and thrown exceptions map to fixed sanitized errors without paths or raw
diagnostics. `sourceAuthenticated`, `publishable`, approval ACK, run-terminal
and resume authority remain false throughout.

`state()` clones the retained view, and integration canonicalizes bounded pages.
These are not zero-copy operations. Real UI integration must avoid calling them
per animation frame and still needs browser/phone performance measurements;
this batch makes **no measured smoothness or memory-ceiling claim**.

## Verification and remaining gates

24 controller tests exercise ordering, partial/end handling, seven scope/lifetime
races, repeated request IDs, refresh rollback, version/hash/identity changes,
provider/content/authority rejection, malformed/getter/cyclic/oversized values,
duplicate/gapped pages, all retention limits, detached ownership, sanitized
failures and the generated browser-language namespace in a Node VM.
Strict TypeScript includes negative authority/scope/dependency assertions.
10 shared-provider tests additionally exercise the fixed profile, source and
reader drift, nested blocks/tool pointers/auxiliary shapes, authority rejection,
scope, getters/cycles/non-JSON values, pre-parse byte cap/UTF-8/BOM/truncation,
detached ownership and real provider/controller integration in Node and the
browser-language VM with Web primitives and no Node globals. These use explicit
accepted/rejected fixtures, not merely equality of two aliases of one function.
VM parity is not actual Safari/Chrome/Firefox/mobile UI acceptance.

The official pinned SDK contract additionally connects this controller to the
real bound isolated worker and shared provider on owned rich, compaction and ancillary fixtures:
forward/backward assembly, observed append becoming stale, preserved old view,
blocked continuation and explicit new-version refresh. macOS/Linux test actual
POSIX source reads; Windows reports `boundClientPagingGate: platform_unsupported`
and only runs pure controller/SDK fixture tests. No real native CLI, model,
private transcript, auth state or subscription credential is touched.

Next: implement and verify the proposed authenticated scoped transport/source
registration and bounded view pool from [the access design](../docs/history-access-design.md);
POSIX ACL/descriptor containment and Windows ownership gate;
then real history presentation/stale controls and multi-Client/browser performance.
Do not turn this inert observation path into a live/durable journal or native
approval/resume path without those independent evidence gates.
