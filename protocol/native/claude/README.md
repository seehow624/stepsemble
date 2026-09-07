# Claude native history boundary

Test-only evidence, not an installed production adapter. The Web still uses the
existing terminal supervisor and opt-in macOS desktop helper. No new capability,
SDK runtime dependency, login, model call or native history mutation is added.

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
canaries verify these two restrictions. No native credentials/settings are
readable. Node's permission mode here is **not network isolation or an OS sandbox**;
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
rejected by the existing canonical JSON guard. The future source reader must
also cap raw bytes **before** JSON parsing and bound filesystem work. This is a
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

## Owner-session evidence and remaining gates

On 2026-09-07, the same SDK read **only** the exact Claude smoke session authorized
and created on 2026-09-06. In a permission-restricted subprocess, the two existing
user/assistant rows, native session identity and fixed marker matched; the file
hash was unchanged. This was not a new model attempt. Sanitized evidence:
[`native-readback-2026-09-07.json`](../../../docs/baselines/native-readback-2026-09-07.json).

These are reader contracts, not a normalized journal import or live UI mapping.
Selected tool/thinking/attachment-reference and interruption/compaction mapping
now has synthetic pinned-SDK coverage. Full attachment materialization, native
source ownership/stable reads, malformed JSONL recovery, subagent attribution,
refusal supersession, approval decision versus native acknowledgement,
resume/reconnect, real persistence, retention and large-history performance
remain unverified. No `approval.resolved`/ACK/run-completed
fact may be manufactured from this preview. Native history remains authoritative;
future publication must use the reserved transaction/projection gates.

Sources: [official session APIs and message identities](https://platform.claude.com/docs/en/agent-sdk/typescript),
[session lifecycle](https://platform.claude.com/docs/en/agent-sdk/sessions).
The installed version's declarations/source were inspected because the current
online reference is not an immutable schema for 0.3.259.
