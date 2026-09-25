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
5. Start app-server only for a reviewed profile, passing the profile's
   capability negotiation parameters.
6. Keep writes and approvals behind a separate exact-profile gate. A
   schema-equivalent future release is read-only until its owned approval
   contract has passed.
7. If the profile is unknown or the schema drifts, keep the regular bounded
   CLI connector available and report a degraded native capability instead of
   failing the whole agent.

## Current profiles

| Profile | History | Pages | Writes / approval |
| --- | --- | --- | --- |
| Codex `0.153.4` | native | native | reviewed native mutation |
| Codex `0.154.0` | native | native | reviewed native mutation |
| Codex `0.156.1` | native | native | reviewed native mutation |
| Future version with a known fingerprint | native read-only | native read-only | disabled |
| Unknown schema or pre-release | bounded fallback | bounded fallback | disabled |

The preflight is local and metadata-only. It does not read the user's real
session store, sign in, call a model, or consume a subscription request.

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
  `thread/goal/get`, `model/list`, `turn/start`, `turn/interrupt`,
  `account/rateLimits/read`) is still present.
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
