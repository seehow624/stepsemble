# Codex compatibility runtime

Stepsemble must not treat a Codex CLI version string as the app-server
contract. The official app-server documentation states that the CLI can emit a
JSON Schema bundle for the exact version being run, and that clients negotiate
capabilities during `initialize`. Stepsemble uses both signals.

## Runtime policy

1. Read `codex --version` without starting a native session.
2. Reject alpha/beta builds before app-server I/O.
3. In an isolated temporary `HOME`/`CODEX_HOME`, run
   `codex app-server generate-json-schema` and hash the bounded contract files.
4. Match the fingerprint against `protocol/native/codex/compatibility.json`.
5. A release whose fingerprint is not reviewed is compared with the latest
   reviewed contract (`contract-baseline.json.gz`, see below). It is used like
   that profile when it only adds to it.
6. Start app-server only for a reviewed, identical or additive profile,
   passing the profile's capability negotiation parameters.
7. If the profile is unknown or the schema drifts, keep the regular bounded
   CLI connector available and report a degraded native capability instead of
   failing the whole agent.

## Current profiles

| Profile | History | Pages | Writes / approval |
| --- | --- | --- | --- |
| Codex `0.153.4` | native | native | reviewed native mutation |
| Codex `0.154.0` | native | native | reviewed native mutation |
| Codex `0.156.1` | native | native | reviewed native mutation |
| Codex `0.157.0` | native | native | reviewed native mutation |
| Codex `0.158.0` | native | native | reviewed native mutation |
| Codex `0.159.0` | native | native | reviewed native mutation |
| Codex `0.161.0` | native | native | reviewed native mutation |
| Future version with a reviewed fingerprint (`schema-identical`) | native | native | native mutation |
| Future version that only adds to the latest reviewed contract (`additive`) | native | native | native mutation |
| Any other schema, or a pre-release | bounded fallback | bounded fallback | disabled |

The preflight is local and metadata-only. It does not read the user's real
session store, sign in, call a model, or consume a subscription request.

## Additive releases

Codex publishes a release every few days, and most of them only add to the
app-server contract. Waiting for a Stepsemble release each time left Codex
conversations unable to send after every Codex update, so a release is
compared with the latest reviewed contract instead (`server/codex-schema-compat.js`).
It is accepted when nothing Stepsemble sends or reads is removed or changed:

- The documents compared are the 26 fingerprinted contract files and the
  responses of the other methods Stepsemble calls (model list, fork, set
  name, goal, rate limits, turn start and interrupt), 33 in all.
- What Stepsemble sends (request parameters of the methods it uses,
  initialize, approval responses) may gain optional fields and accepted
  values, and a sent shape may become one member of a union. A new required
  field, a removed field or accepted value, or a narrower type is a change.
- What Stepsemble reads (responses, notifications, server requests) may gain
  fields, enum values and union members. A removed field, notification,
  union member or enum value, a field that is no longer always present, or a
  different type is a change.
- Request methods Stepsemble does not use may change or go away. A
  definition may be renamed when its shape still fits.
- Anything the comparison cannot classify is a change.

Run against the published contracts of every stable release from 0.151.0 to
0.159.0, each release after the one before: 15 of 16 only add, and 0.156.0 is
refused because it removed the `url` field of an image input, which
Stepsemble sends. Removing a field Stepsemble reads, making a sent field
required, removing `turn/completed`, `turn/start` or an approval decision,
and changing a type are each refused (`test/codex-schema-compat.test.js`).
The same values written another way (a list of types as a union, or a union
moved behind a reference, as 0.159.0 did) are compared shape by shape: each
shape Stepsemble sends must still be accepted, and each shape it reads must be
one it knew. A union written with `anyOf` instead of `oneOf`, as 0.161.0 did,
is the same union; written the other way it may refuse a value Stepsemble
sends. A verdict kept per release is made again when the comparison changes
(`COMPARISON_VERSION`).

`protocol/native/codex/contract-baseline.json.gz` holds the documents of the
latest reviewed release. It is checked against that profile's hashes when it
is read, and a test requires it to be the newest reviewed profile: after
reviewing a release, add its profile and run
`node scripts/codex-contract-baseline.mjs <version>`.

## Before an update

The Updates page updates Codex only to a release Stepsemble supports
(`server/codex-release-check.js`). The official repository publishes each
release's contract documents under `codex-rs/app-server-protocol/schema/json`
at tag `rust-v<version>`; they are byte-identical to what the executable
generates (checked for 0.156.1, 0.157.0 and 0.158.0, and for all 33 documents
of 0.158.0) and about 1 MB, where the release is 70 to 100 MB. A reviewed
release needs no download; any other is read and compared as above. The
verdict is kept per release in `~/.config/stepsemble/codex-release-checks.json`;
one that could not reach GitHub is tried again after ten minutes and refuses
the update meanwhile. An npm installation is updated to exactly the checked
release; Homebrew and the standalone updater install the newest one, so a
newer release installed in the meantime is checked again afterwards. After an
update, idle Codex app-servers are started again from the executable now
installed, which the runtime policy above checks before use.

### 0.154.0 review record

Reviewed by comparing the generated schema set against the `0.153.4`
baseline. Of the 26 schema files, 14 are byte-identical and 10 differ. The
review checked whether the differences touch anything Stepsemble writes:

- The three approval responses it sends — `CommandExecutionRequestApproval`,
  `FileChangeRequestApproval`, and `PermissionsRequestApproval` — are
  byte-identical to the reviewed baseline.
- `ThreadStartParams` is byte-identical.
- `ThreadResumeParams` grew by optional properties; its only required field
  is still `threadId`.
- `PermissionsRequestApprovalParams` shrank, but the correlation fields the
  approval bridge depends on (`threadId`, `turnId`, `itemId`) remain
  required.
- All eight request methods in use (`thread/start`, `thread/resume`,
  `thread/read`, `thread/list`, `thread/turns/list`,
  `thread/items/list`, `turn/start`, `turn/interrupt`) are present among
  the 99 advertised methods.

The observed fingerprint matches the registered one exactly, so the schema
carries no unreviewed drift. `0.154.0-schema.json` records the baseline.

### 0.156.1 review record

Reviewed against the `0.154.0` baseline. Of the 26 contract files, 16 are
byte-identical, including every approval request and response and
`ServerRequest`. The other 10 add optional fields or methods (thread
attachments, MCP app UI, collaboration mode, disabled plugin ids, image input by
URL or file id) or reword descriptions:

- The approval responses Stepsemble sends and `ThreadStartParams` are
  unchanged.
- Every request method in use (`thread/start`, `thread/resume`,
  `thread/read`, `thread/list`, `thread/turns/list`, `thread/items/list`,
  `thread/goal/get`, `thread/name/set`, `model/list`, `turn/start`,
  `turn/interrupt`, `account/rateLimits/read`) is still present.
- `thread/rollback` was removed. Stepsemble never calls it.

The Approval control sends turn overrides limited to a plain `approvalPolicy`
and a `sandboxPolicy` of `{type}` from Stepsemble's three presets (read only,
default and full access). The composer, parallel-pool and approval oracles
passed against the real 0.156.1 binary locally, including a turn override of
`on-request` with `workspaceWrite`. CI keeps using the pinned official
`0.154.0` artifact. `0.156.1-schema.json` records the baseline.

Before a thread's first message, both releases refuse history reads:
`thread/turns/list` reports that the thread is not materialized yet, and
`thread/items/list` reports that it is not supported. Stepsemble reads that
state as an empty history instead of a failure.

`thread/name/set` has byte-identical parameters and response in 0.154.0 and
0.156.1, and both releases accept it before the first message. Stepsemble uses
it once, for the name typed for a new conversation, through the process that
owns the thread. A named thread without a first message is refused with
`missing source rollout` instead, and Codex's own thread list leaves it out
until that message. Stepsemble therefore records that it started the thread
and reads it as empty until its first turn, whatever reason Codex gives.

### 0.157.0 review record

Reviewed against the `0.156.1` baseline. 22 of the 26 contract files are
byte-identical, including every approval request and response,
`ServerRequest`, and the thread start, resume, read, list and turns-list
schemas. The four that differ only add optional fields or methods:

- `ClientRequest.json`: three gateway OAuth methods
  (`account/gatewayOAuth/read`, `login` and `cancel`), an optional
  `explicitGatewayOauth` initialize capability and an optional `target` for
  MCP resource reads.
- `ServerNotification.json`: a gateway OAuth status notification, which
  Stepsemble ignores.
- `v1/InitializeParams.json`: the same optional capability. Stepsemble does
  not send it.
- `v2/ThreadItemsListResponse.json`: optional `startedAtMs` and
  `completedAtMs` on each item entry. Stepsemble reads only `turnId` and
  `item`.

Every request method in use is still present. The composer, parallel-pool
and approval oracles passed against the official 0.157.0 macOS arm64
artifact (archive SHA-256 `0f1522362bf8c8bbb58bf2fa8a3c600a0b723f1d4e3405ab831afeda32438909`,
matching the digest GitHub publishes for the release), including a turn
override of `on-request` with `workspaceWrite`. Naming a thread, the
history refusals before a first message and the thread list behave as in
0.156.1. `0.157.0-schema.json` records the baseline.

### 0.158.0 review record

Reviewed against the `0.157.0` baseline, generated from the official npm
artifacts of both releases for macOS arm64 (the 0.157.0 build reproduces the
recorded fingerprint). 20 of the 26 contract files are byte-identical,
including `ClientRequest`, `ServerRequest`, every approval request and
response, and the thread start, resume, read and list parameters. The six
that differ (`ServerNotification` and the thread list, read, turns-list,
resume and start responses) share two enum additions and nothing else:

- `CodexErrorInfo` gains `flexUnavailable`. Stepsemble does not match on
  error kinds.
- `PlanType` gains `promax`. Stepsemble does not read the plan type.

The composer, parallel-pool and approval oracles passed against the official
0.158.0 artifact (npm `@openai/codex@0.158.0-darwin-arm64`, archive SHA-256
`7849f8aa87c3956823cef082d83b538980a0ced6e468cca4f39c1cf606ea8dae`), with
the version pins of the scripts changed only for that run. An owned branch
run passed as well: a thread named and answered twice, `thread/fork` through
the first turn, the branch resumed, named and answered with the first turn
and without the second, and the original unchanged. `0.158.0-schema.json`
records the baseline.

### 0.159.0 review record

Reviewed with `scripts/review-codex-release.mjs` against the `0.158.0`
baseline, from the official npm artifact
(`@openai/codex@0.159.0-darwin-arm64`, archive SHA-256
`36034ef21c4fd7992e3ca4d041dff869dbf8c5d742b68e5c9fad0c3636cf61ce`). 23 of the
33 contract files are identical; the others are `ClientRequest.json`,
`ServerNotification.json`, `v2/ThreadListResponse.json`,
`v2/ThreadReadResponse.json`, `v2/ThreadTurnsListResponse.json`,
`v2/ThreadItemsListParams.json`, `v2/ThreadResumeResponse.json`,
`v2/ThreadStartResponse.json`, `v2/ThreadForkResponse.json`,
`v2/TurnStartResponse.json`. None of the changes removes or alters anything
Stepsemble sends or reads. The composer, parallel-pool, approval and branch
oracles passed against that artifact with a local model. `0.159.0-schema.json`
records the baseline.

What changed, file by file:

- `thread/items/list` takes an item anchor as well as a string cursor:
  `cursor`, a string or null, became a union of `ThreadItemsListCursor` (a
  string, or `{ type: "item", itemId }`) and null. Stepsemble sends the string
  Codex returned, which is still accepted. The comparison first refused it
  ("values restricted"), since the same values were written another way: a
  list of types became a union behind a reference. It now compares such a
  rewrite shape by shape (`form` and `shapes` in
  `server/codex-schema-compat.js`): every shape Stepsemble may send must
  still be accepted by one of the new shapes, and every shape it may read
  must be one it knew. Run again on the published contracts of every stable
  release from 0.151.0 to 0.159.0, only 0.156.0 is refused, for the same
  reason as before (`test/codex-schema-compat.test.js` covers the rewrite
  and the cases that must stay refused).
- `CodexErrorInfo` gains `tooManyDenials`; Stepsemble does not match on error
  kinds. A turn's `error` is now described as "a failed or interrupted
  turn"; Stepsemble reads an interrupted turn from its `status` and does not
  read `Turn.error`.
- MCP resource discovery gains an optional `serverName`; Stepsemble does not
  call it. The other files differ only in descriptions.

### 0.161.0 review record

Reviewed with `scripts/review-codex-release.mjs` against the `0.159.0`
baseline, from the official npm artifact
(`@openai/codex@0.161.0-darwin-arm64`, archive SHA-256
`21c99b848b25ed91b92afadabe3751cc33878d2684f3e2d01cc1782e6d0abc7a`). 23 of the
33 contract files are identical; the others are `ClientRequest.json`,
`ServerNotification.json`, `v2/ThreadListResponse.json`,
`v2/ThreadReadResponse.json`, `v2/ThreadTurnsListResponse.json`,
`v2/ThreadResumeResponse.json`, `v2/ThreadStartResponse.json`,
`v2/ModelListResponse.json`, `v2/ThreadForkResponse.json`,
`v2/TurnStartResponse.json`. None of the changes removes or alters anything
Stepsemble sends or reads. The composer, parallel-pool, approval and branch
oracles passed against that artifact with a local model. `0.161.0-schema.json`
records the baseline.

What changed, file by file:

- `CodexErrorInfo` lists its members with `anyOf` instead of `oneOf`, and
  gains a member that is any string or object, for error kinds still to come.
  The comparison first refused it in the six files that carry it ("union
  replaced"): it only lined up two unions written with the same keyword. It
  now takes a union written with `oneOf` and with `anyOf` as the same union
  and compares the members as usual, since `anyOf` accepts every value
  `oneOf` does; the other way round stays a change for what Stepsemble sends
  (`COMPARISON_VERSION` 3; `test/codex-schema-compat.test.js`). Stepsemble
  does not read `codexErrorInfo`.
- `thread/goal/set` and `thread/goal/clear` take an optional `origin`;
  Stepsemble does not call them. `ModelListResponse.json` differs only in
  descriptions.

## Automatic Codex upgrades

Each Host has an "Upgrade automatically" switch on the Codex row of the
Updates page (off until turned on; `POST /api/harness-updates/auto`,
stored in `~/.config/stepsemble/codex-auto-upgrade.json`). With it on, the Host
checks about once an hour, and two minutes after it starts, whether a newer
Codex is published, and installs it through the same checked upgrade as the
Upgrade button: only to a release this Stepsemble supports (reviewed, the same
contract as a reviewed one, or one that only adds to the latest reviewed one),
and only while no agent is working (tried again ten minutes later). A release
it cannot support waits; once a Stepsemble update supports it, the next check
installs it. A release whose install fails three times is left alone until the
switch is turned on again. Codex's own updater may install a release first;
the runtime check then decides, as for any installed Codex.

## Reviewing a new Codex release

`npm run -s watch:codex` says whether the newest Codex on npm needs anything:
`none` (reviewed), `upgrade` (supported as it is; Hosts upgrade by themselves),
`adapt` (it changes something Stepsemble uses) or `wait` (not checkable yet).

`node scripts/review-codex-release.mjs <version> --write` reviews a release from
the official npm artifact: it compares its contract with the latest reviewed
one, records the schema file, the reviewed profile, the contract baseline and
a review record here, and requires the composer, parallel, approval and
branch oracles to pass against the artifact first (a local fake model; no
account or paid request). A release that changes something Stepsemble uses
stops with exit code 2 and the list of changes; after Stepsemble has been
changed for them, `--write --adapted` records it. The oracles take the
version under review from `STEPSEMBLE_ORACLE_CODEX_VERSION`; without it they keep
their CI pins.

## Upgrade monitor

The first watcher is now shipped as `npm run watch:harness`. It observes the
installed versions of Codex, Claude Code, OpenCode, Pi, Hermes and Gemini CLI,
and keeps extension/hosted harnesses such as Cline, Kilo, Grok Build and
Antigravity visible as explicit `manual` entries. The report is written to
`~/.config/stepsemble/harness-compatibility.json` with owner-only permissions.

Codex receives the full isolated schema preflight. The other harnesses are
intentionally `version-only` until their native contracts are owned and tested;
an observed upgrade is therefore reported as `needs-review` rather than being
silently enabled. `--watch` can keep the process alive for a local scheduler,
while the default one-shot mode is suitable for launchd/systemd or a future
Stepsemble daemon.

The next phase can add signed release-feed adapters and per-harness contract
probes. A passing probe may create a staged registry update and canary; a
failed or unknown probe leaves the last working connector untouched. The
watcher must never auto-enable an unknown write or approval protocol.

See the official [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server)
for the protocol and schema-generation contract.
