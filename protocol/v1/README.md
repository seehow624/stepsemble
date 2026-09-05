# Protocol v1 — incremental migration contracts

The canonical machine-readable definitions are in `schema.json` (JSON Schema
2020-12). `fixtures/negotiation.json` freezes sanitized, isolated Node wire
responses. The HTTP contract tests replay these against a real server and can
be reused by a future Rust server. No fixture contains native account data.

Currently implemented: authenticated `POST /api/protocol/handshake`, protocol
range and capability negotiation, typed client request/error handling, shared
schema shape validation, and UI connection-time negotiation. The host advertises only
`legacy.http`, `pi.native-rpc`, and `agent.terminal-v1`. Domain definitions for
session/run/approval/profile/event/cursor/commands are **reserved**, not live
endpoints or promises of durable behavior. Legacy HTTP/RPC wire formats remain
unchanged. Existing peers need not implement the new handshake. The UI coalesces
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

`npm run build:protocol` generates `public/modules/protocol-contracts.js` from
the same validator and canonical JSON schema; `check:protocol` gates CI and
release artifacts. Node and browser run the same sanitized fixtures in
`fixtures/domains.json`, including mutations for missing required fields,
invalid scopes/states, timestamps and unsafe sequences. Typed `parse()` covers
nativeReference/session/run/approval/launchProfile/event/cursor/command/page.

These are envelope/entity **shape** contracts. Event/command payload schemas,
cross-entity ownership, approval expiry enforcement, credential-reference policy,
billing compatibility, cursor continuity and durable state transitions still
require their own validators and tests before domain endpoints are enabled.
Independent validation-engine conformance remains a gate; same-code Node/browser
parity must not be represented as two independent implementations agreeing.

## Compatibility policy

- Clients ignore additive object fields. Missing required fields or incompatible
  versions fail explicitly. A missing handshake endpoint (404) identifies an old
  host; 401, transport failures and 426 must never silently downgrade.
- v1 selects the highest mutually implemented version (currently only 1).
  Disjoint ranges return 426; reversed/fractional/unsafe ranges return 400.
- Schema patch/minor revisions may add optional fields or event types. Removing
  fields or changing semantics requires a new protocol major. Supporting the
  previous two shipped Client releases remains a release-matrix requirement;
  it has not yet been demonstrated by this initial contract.
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
  Consumers can preserve unknown informational events, but unknown state-changing
  semantics require resynchronization. Event sequencing/replay is a later slice.
- Approval scope and expiry are mandatory. No default approval is implied by a
  missing/unknown capability. Native credentials must never enter an envelope.

`client/client.ts` builds to the checked-in `public/modules/client-sdk.js` using
`npm run build:client`; `npm run check:client` checks strict types and artifact
identity. The compiler is pinned to TypeScript 7.0.2; npm cache and intermediate
output are local temporary files. The deployed PWA needs neither npm install
nor a compiler. Runtime request cancellation and existing auth UI are preserved.

Still required for the full Phase 1 gate: discriminated domain payload contracts
and semantic invariants, independent schema conformance, native Pi golden transcripts,
sequencing/cursor recovery, and the rolling
Client compatibility matrix. Do not mark Phase 1 complete from this slice.
