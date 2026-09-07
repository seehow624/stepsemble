# Reserved inert-history Client view

Plan 1.40. `client/history-pages.ts` builds `public/modules/history-pages.js`.
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
detached JSON value. Tests use the real Claude worker-wire validator through a
**test-only Node bridge**. A reusable browser provider adapter, authenticated
transport, source registration and authorization remain unimplemented. Do not
attach the reserved module to production by substituting a permissive validator.

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
VM parity is not actual Safari/Chrome/Firefox/mobile UI acceptance.

The official pinned SDK contract additionally connects this controller to the
real bound isolated worker on owned rich, compaction and ancillary fixtures:
forward/backward assembly, observed append becoming stale, preserved old view,
blocked continuation and explicit new-version refresh. macOS/Linux test actual
POSIX source reads; Windows reports `boundClientPagingGate: platform_unsupported`
and only runs pure controller/SDK fixture tests. No real native CLI, model,
private transcript, auth state or subscription credential is touched.

Next: reviewed browser provider decoder and authenticated scoped transport/source
registration design; POSIX ACL/descriptor containment and Windows ownership gate;
then real history presentation/stale controls and multi-Client/browser performance.
Do not turn this inert observation path into a live/durable journal or native
approval/resume path without those independent evidence gates.
