# Stepsemble architecture

> This document describes the currently shipped Node/PWA architecture. The
> accepted target architecture, language boundaries, migration gates, and
> cross-platform roadmap live in [`platform-plan.md`](platform-plan.md). The
> frozen implementation inventory and measured Host baseline live in
> [`current-system-inventory.md`](current-system-inventory.md) and
> [`performance-baseline.md`](performance-baseline.md). Read all four before
> making substantial architecture changes.

Stepsemble 3 intentionally remains a dependency-free Node/PWA application. The
runtime is local to each coding-agent host, so the app must continue to work
without a build server and must keep launchd, Tailscale, SSE, and the updater
simple.

Reliability changes (2026-09-05) are documented separately in
[`reliability-followup.md`](reliability-followup.md): recoverable session archive,
bounded stream framing/writes, supervisor snapshot replacement, asynchronous
worktrees, and scoped history/localization rendering. They are included in the
owner-authorized Mini activation of 3.0.4-rc.3 on 2026-09-06; the public stable
baseline remains 3.0.3. Do not interpret them as durable full history,
approval parity, or the Rust migration being complete.

The Mini also uses the opt-in macOS Claude desktop helper described in
[`claude-desktop-runner.md`](claude-desktop-runner.md). The existing SSH Web Host
retains HTTP/SSE ownership; a private Unix IPC boundary starts official Claude
login and task supervisors in the Aqua desktop context. Other connectors are
not moved. Metadata and deployed UI checks pass, but actual OAuth/model and
native session/approval parity remain separate gates.

Development candidate rc.4 corrects legacy Pi idle-exit classification, guards
send/close races and shares native-name/first-user title precedence through a
strict TypeScript helper. See [`pi-session-lifecycle.md`](pi-session-lifecycle.md).
This candidate is not activated on the live rc.3 Host and is not a durable
session/run store or another native account/model verification.

## Boundaries

```text
server.js
  ├─ Pi/session/provider/device behavior and route table
  ├─ server/agent-connectors.js  allow-listed local Agent connectors and task journal
  ├─ server/connector-protocol.js versioned connector manifest/event contract
  ├─ server/agent-task-supervisor.js one detached supervisor per generic task
  ├─ server/pty-bridge.py        dependency-free Unix PTY bridge for interactive CLIs
  ├─ server/device-trust.js  one-time pairing, peer credentials, and atomic grants
  ├─ server/http-utils.js  HTTP headers, cookies, auth modes, JSON bodies, SSE framing
  └─ access-token store     optional per-device/person browser tokens (hash-only)

public/index.html
  ├─ public/i18n.js
  ├─ public/modules/app-foundation.js  settings, themes, device helpers
  ├─ public/modules/session-utils.js   pure session display helpers
  └─ public/app.js                     view controller and feature flows
```

The small modules are loaded as ordinary browser scripts rather than bundled
by Next.js or Vite. This preserves the current deployment contract while
giving future work a stable place to add feature modules. New domain code
should prefer pure helpers in `public/modules/` or server modules with an
explicit input/output boundary before adding more state to the controllers.

## Runtime rules

- Keep API and relay requests out of the service-worker cache.
- Agent Hub uses one versioned connector contract for Pi and local CLI agents.
  The public catalog includes `protocolVersion`, capabilities, and lifecycle
  event types so future adapters can be added without changing the browser API.
  Pi keeps
  its native JSON-RPC/session history; Claude Code, Codex CLI, Grok Build, and
  OpenCode are discovered from an explicit allow-list and run only from their
  resolved executable path. The browser can submit an Agent id and text, never
  an arbitrary command or shell fragment.
- Generic CLI tasks have a bounded, private journal at
  `~/.config/stepsemble/agent-tasks.json` (mode `0600`). Their stdout/stderr is
  streamed over authenticated SSE and retained as a short output tail so a
  browser can leave and later reopen the task. On macOS/Linux, the bundled
  stdlib-only `server/pty-bridge.py` gives interactive CLIs a real terminal;
  Windows and hosts without Python use the safe pipe transport instead.
  Each generic task is owned by a detached `agent-task-supervisor.js` process.
  Its owner-only Unix socket (or local Windows named pipe) and private snapshot
  live independently from `server.js`; bounded event replay remains in the
  supervisor's memory, while only the short output tail is persisted. A
  graceful Stepsemble restart drops HTTP/SSE clients, then the next process
  reattaches to the supervisor and resumes the timer/output. If the host or
  supervisor is killed, the snapshot records `orphaned` rather than claiming
  that work is still running; Pi JSON-RPC runs keep the existing
  graceful-restart behavior.
- Worktree selection is server-side validated and uses the existing permanent
  Git worktree helper. A task's working directory and branch are exposed to the
  browser, while credentials and environment values stay on the host.
- Keep secrets in the server process or local Pi configuration; never expose
  them through public client modules.
- Keep generated build output out of the project volume. A future React build
  may use a local temporary output directory, but it must not become a runtime
  requirement for the self-hosted server.
- Preserve the public API paths so older paired devices can be upgraded
  independently. Browser cookies remain the compatibility path for manually
  added and already-saved machines; newly paired machines use a dedicated
  bearer credential instead.
- `STEPSEMBLE3` is a five-minute, one-use, out-of-band pairing capability. The
  joining host reviews its decoded candidate locally before making a network
  request. The target stores only the incoming credential hash, while the
  joining host stores its outgoing credential in `~/.config/stepsemble/device-trust.json`.
  Grants are listed and revoked from Device settings, and revocation is
  enforced on the next request without a remote delete call.
- `PIHARBOR3` remains accepted as the former name of the v3 pairing envelope.
  `PIHARBOR2` remains accepted when a current host joins a v2.1.2 offer through
  the legacy HMAC path; it receives no dedicated credential. An older client
  cannot silently downgrade a `STEPSEMBLE3` offer and must update.
- Product-state migration is additive. New writes use `~/.config/stepsemble`,
  the `stepsemble` cookie, `STEPSEMBLE_*` variables, and Stepsemble service
  labels. Reads also accept the former Pi Harbor/Pi Web paths, cookies,
  variables, and pairing prefixes for a bounded compatibility window. The
  installer archives former application/service files only after a matching
  v3 health check; native agent state and projects are never moved.
- Optional access tokens are managed only by the installer/master token from
  Settings. The server stores only hashes in `~/.config/stepsemble/tokens.json`
  with mode `0600`; revocation invalidates existing browser cookies at the
  next authenticated request. They are host credentials, not multi-user Pi
  accounts or per-project ACLs.
- The updater performs archive-name/type preflight before extraction and probes
  `/api/health` after launchd activation. If the new process does not report the
  expected release version, it restores the previous verified directory and
  records a rollback state. Releases
  publish a SHA-256 checksum plus a GitHub OIDC artifact attestation; the local
  updater still requires only the checksum. Mermaid is bundled in
  `public/vendor/mermaid.min.js` and loaded lazily, so diagram sources stay
  local and offline rendering does not depend on a CDN.

## Migration path

Development follow-up (2026-09-05, not released as 3.0.3): JSON requests now pass
through the strict TypeScript client in `client/client.ts`, emitted as a normal
browser script in `public/modules/client-sdk.js`. The additive authenticated
protocol handshake reports existing capabilities only; the full Phase 1 gate
remains open. Windows batch CLI shims use `server/windows-launch.js` with fixed
cmd.exe switches and a validated absolute filename, while all prompts go over
stdin. Windows stop terminates the owned process tree, including shim children.
Only the supervisor is detached on Windows; a second detached console context
for the CLI caused pipe output to stall in the Windows runner. Regression tests
cover pipe IO, web-service restart/reattachment, and actual owned-process exit.
Native executables and Unix PTYs retain their direct launch paths.

The next low-risk extractions are session rendering, provider management, and
device management. A React/Vite client can be introduced later if those areas
need component-level isolation; a full Next.js migration should wait until
Stepsemble becomes a multi-user hosted service.
