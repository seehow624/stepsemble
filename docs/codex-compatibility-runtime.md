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
| Codex `0.154.0` | native | native | read-only until owned mutation contract |
| Future version with a known fingerprint | native read-only | native read-only | disabled |
| Unknown schema or pre-release | bounded fallback | bounded fallback | disabled |

The preflight is local and metadata-only. It does not read the user's real
session store, sign in, call a model, or consume a subscription request.

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
