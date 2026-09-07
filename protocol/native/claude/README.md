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

The fixture includes a branched transcript, Unicode, internal queue/title records
and two assistant rows belonging to one API response. Tests establish:

- Native parent-chain selection and row order are preserved, not flattened by
  timestamps or read order across alternative branches.
- Message `uuid` is the row identity. Multiple rows may share `message.id` within
  one API response; collapsing them by that API ID loses history.
- Native custom title, pagination, session correlation and Unicode survive readback.
- Missing/invalid sessions return an empty array. **An empty SDK result is not
  sufficient proof of an empty valid history**; a future Host must distinguish
  unavailable/corrupt/missing sources before publishing an empty projection.
- The synthetic native JSONL and the imported SDK source are unchanged afterward.

Ordinary `npm test` only checks synthetic fixtures and guards, without SDK download.
The separate Native Claude history contract workflow runs the pinned real SDK
reader on macOS, Linux and Windows; it does not run any native agent/model.

## Owner-session evidence and remaining gates

On 2026-09-07, the same SDK read **only** the exact Claude smoke session authorized
and created on 2026-09-06. In a permission-restricted subprocess, the two existing
user/assistant rows, native session identity and fixed marker matched; the file
hash was unchanged. This was not a new model attempt. Sanitized evidence:
[`native-readback-2026-09-07.json`](../../../docs/baselines/native-readback-2026-09-07.json).

These are reader contracts, not a normalized journal import or live UI mapping.
Full tool/thinking/attachment history, compaction, subagent attribution, interrupted
or corrupt transcripts, authenticated source ownership, approval decision versus
native acknowledgement, resume/reconnect, real persistence, retention and large
history performance remain unverified. No `approval.resolved`/ACK/run-completed
fact may be manufactured from this preview. Native history remains authoritative;
future publication must use the reserved transaction/projection gates.

Sources: [official session APIs and message identities](https://platform.claude.com/docs/en/agent-sdk/typescript),
[session lifecycle](https://platform.claude.com/docs/en/agent-sdk/sessions).
The installed version's declarations/source were inspected because the current
online reference is not an immutable schema for 0.3.259.
