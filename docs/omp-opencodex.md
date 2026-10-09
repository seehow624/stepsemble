# OMP through OpenCodex

The OMP model settings page and `/login` sheet offer **Use OpenCodex** alongside direct provider sign-in. The command runs on the selected Stepsemble Host. A phone or another computer controlling that Host does not open its localhost OAuth callback.

OpenCodex must already be running on that Host with providers and models configured. Enable the integration, then start a new OMP conversation and choose an `opencodex/…` model. Existing conversations keep their selected model. This does not sign into providers for the user, migrate credentials or change other agents' routing.

## Implementation

The Host executes fixed arguments through the discovered local CLI:

- Read: `ocx integration client status --client omp --json`
- Enable/refresh: `ocx integration client enable --client omp --json`
- Remove: `ocx integration client disable --client omp --json`

OpenCodex owns the YAML writer, conflict checks and backup journal. Stepsemble never requests `--overwrite-conflict`, writes provider secrets or copies account credentials. The returned OMP configuration path must match the Host's HOME/profile, including the `models.yaml` fallback. Command failure, malformed output and an unconfirmed post-write state cannot be shown as success. CLI output and configuration paths are not returned to the browser.

`GET /api/gateway/status?agentId=omp` adds an OMP integration state. `POST /api/gateway/action` accepts `{ "action": "omp_integration", "enabled": true }` (or false); extra keys and non-booleans are rejected. Existing authentication and remote Host forwarding apply, with Origin required for cookie-authenticated changes. Concurrent mutations are rejected. Browser actions retain the selected Host and discard replies after a Host/view change.

Connection checking only checks the local gateway and model catalog. It does not make a billable inference request or prove upstream credentials are valid. Missing or outdated OpenCodex, offline/empty catalogs, configuration conflicts and mismatched profiles have actionable UI messages. Direct sign-in remains available.

## Verification — 2026-10-09, macOS arm64

- Service tests: managed CLI arguments, enable/remove readback, stale refresh, conflict/unsafe refusal, offline and empty catalogs, invalid JSON, process errors/timeouts, uncertain writes, profile mismatch and concurrent clients.
- Real isolated Host HTTP tests: authentication/Origin, body validation and successful enable/remove using a synthetic CLI and gateway.
- UI controller tests: repeated clicks, changing Host during lookup or before clicking, closing during an action, retry and direct-login fallback.
- Computer Use: Traditional Chinese dark UI; settings enable flow and OMP sign-in sheet. At 390 × 844 the page remains 390 pixels wide and both options are visible. The phone-width sheet completes the synthetic integration successfully.
- Installed OpenCodex 2.51.0 read-only CLI check: the existing local OMP integration reports `current`; no enable/remove command was run against production.
- Native OMP 18.6.1 smoke: start the installed OMP with a temporary HOME and no model credentials; verify `acp_auth_required`, add a synthetic OpenCodex provider, open a new session in the same process, select the model and receive a reply from a local model fixture. No real provider account or quota is used. Reproduce with `node scripts/check-native-omp-gateway.cjs /absolute/path/to/omp`.
- Final release suite: 1,848 passed, 5 platform skips, 0 failures. Syntax, client build, protocol artifacts and 1,251 independent schema conformance cases passed.

This feature is included in 3.8.34. Production OMP routing and provider credentials have not been changed by these tests. Windows/Linux native GUI or model execution was not tested on this Mac.
