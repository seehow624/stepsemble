<p align="center">
  <img src="public/stepsemble-logo.svg" width="112" height="112" alt="Stepsemble four-module logo">
</p>

<h1 align="center">Stepsemble</h1>

<p align="center">
  Coding agents, working in step.
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-1A1A1A"></a>
  <img alt="macOS Linux Windows" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-1A1A1A">
  <img alt="Node.js 22.19+" src="https://img.shields.io/badge/Node.js-22.19%2B-1A1A1A">
</p>

<p align="center">
  English · <a href="README.zh-Hans.md">Chinese (Simplified)</a> ·
  <a href="README.zh-Hant.md">Chinese (Traditional)</a> ·
  <a href="README.ja.md">Japanese</a> · <a href="README.ko.md">Korean</a> ·
  <a href="README.tr.md">Turkish</a> · <a href="README.fr.md">French</a> ·
  <a href="README.de.md">German</a> · <a href="README.es.md">Spanish</a> ·
  <a href="README.pt-BR.md">Portuguese</a> · <a href="README.it.md">Italian</a>
</p>

Stepsemble is an open-source, self-hosted workspace for local coding agents.
It gives [Pi Agent](https://github.com/badlogic/pi-mono) a native session
experience and can also launch installed Claude Code, Codex CLI, Grok Build,
and OpenCode connectors from one desktop or phone interface.

Stepsemble is an independent community project. It is not an official product
of, or affiliated with, Pi, Anthropic, OpenAI, xAI, or OpenCode.

## Install on macOS

Run this on every computer that should host Stepsemble:

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/stepsemble/master/install.sh)"
```

The installer:

- detects an existing Pi Agent and offers the official Pi installer when Pi is
  missing;
- installs a private Node.js runtime only when Node 22.19 or newer is missing;
- downloads the latest GitHub Release and verifies its SHA-256 checksum;
- creates a local Web token at `~/.config/stepsemble/token`, a launchd service, and an hourly stable-release updater;
- migrates Pi Harbor and Pi Web installations without changing native agent
  sessions, project files, provider credentials, approvals, or the existing
  Web token.

For a review-first installation, download the script before running it:

```bash
curl -fsSLO https://raw.githubusercontent.com/seehow624/stepsemble/master/install.sh
less install.sh
zsh install.sh
```

### Install on Linux or Windows

Linux uses a per-user systemd service and an optional hourly update timer. It
requires Node.js 22.19 or newer:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/stepsemble/master/install-linux.sh)"
```

Windows uses a per-user Scheduled Task (no administrator prompt) and requires
Node.js 22.19 or newer plus the built-in `tar.exe`:

```powershell
irm https://raw.githubusercontent.com/seehow624/stepsemble/master/install-windows.ps1 -OutFile install-windows.ps1
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
```

The scripts keep the same token location (`~/.config/stepsemble/token`, or
`$HOME\.config\stepsemble\token` on Windows) and bind the server to loopback.
Put Tailscale Serve or another authenticated HTTPS gateway in front of it for
remote access.

Stepsemble binds to `127.0.0.1:3140` by default. The first launch opens a short
setup guide for sign-in, devices, providers, projects, and remote access.

### Upgrading from Pi Harbor

The v3 installer treats the rename as an additive migration. It copies known
private state from `~/.config/pi-harbor` or `~/.config/pi-web` only when the
equivalent Stepsemble file does not exist. The former source stays in place for
rollback. Browser preferences, drafts, selected devices, cookies, environment
variables, and `PIHARBOR2`/`PIHARBOR3` pairing codes remain readable, while all
new writes use Stepsemble names.

On supported service managers, old application and service files are archived
only after Stepsemble 3 reports a healthy matching version. Pi-owned data under
`~/.pi`, Claude Code/Codex/OpenCode-owned state, provider credentials, and
project folders are never moved. v3 releases also publish the former
`pi-harbor-*` asset name so an installed v2 updater can cross the rename.

### Find the Web token

On the computer running Stepsemble, open a terminal and run the command for its
operating system.

macOS (Terminal) and Linux:

```bash
cat ~/.config/stepsemble/token
```

Windows (PowerShell):

```powershell
Get-Content $HOME\.config\stepsemble\token
```

Windows (Command Prompt):

```bat
type %USERPROFILE%\.config\stepsemble\token
```

From another device, retrieve the token securely from that host and paste it into
the sign-in screen. If the service was deliberately configured with
`STEPSEMBLE_TOKEN_FILE`, read that configured file instead of the default path.
Never share the token in chat, screenshots, repositories, or logs.

When a browser on the host computer itself opens Stepsemble for the first time,
a hardware-wallet-style onboarding offers to reveal the private access key
once before sign-in. It is shown only on loopback connections — never through
Tailscale Serve, a proxy, or a remote device — and only until both
acknowledgements are saved. Afterwards the reveal never appears again; other
devices always use the recorded key or the token file.

### Additional access tokens

For a host shared by multiple people or devices, open **Settings → Access tokens**
with the installer/master token to issue a labelled token. Each token is shown
only once, can be revoked independently, and is stored only as a SHA-256 hash in
`~/.config/stepsemble/tokens.json` (mode `600`). These are still host-level
credentials with the same access as the master token; they do not create
separate Pi accounts or project permissions.

## Secure remote access

Keep the Node port private. Use Tailscale Serve or another authenticated HTTPS
gateway instead of exposing port `3140` to an untrusted network. A generic
Tailscale example is:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:3140
```

Open the HTTPS address and enter the token stored at
`~/.config/stepsemble/token` (or the file configured by
`STEPSEMBLE_TOKEN_FILE`). Optionally add the site to the home screen. Never paste
that token into an issue, chat, screenshot, log, or repository.

## Multiple computers

Each Pi Agent computer runs its own Stepsemble instance. Install and run Stepsemble
on every host, then use **Settings → Devices → Add device** to add a Tailscale or
HTTPS address. Manual URL entry remains the legacy shared-Web-token path and
requires the same Web token on both hosts. Prefer a five-minute `STEPSEMBLE3`
one-time pairing code: after you review the candidate details, it provisions an
independent, revocable peer credential and never sends the shared token to the
candidate. Authorized peer grants can be listed and revoked in Device settings;
revocation takes effect immediately. Stepsemble 3 accepts `PIHARBOR3` codes and
the token-authenticated `PIHARBOR2` transition format from older hosts. Older
clients must update before they can read a new `STEPSEMBLE3` code.
Keep port `3140` private and do not expose it to an untrusted network.

To add an LLM provider, open **Settings → Connection → Models & providers**.
Choose a catalog service, account/OAuth sign-in, API key, local service, or
Custom provider. Then select the visible models you want to use.

### Agent Hub connectors

The **Agent Hub** card discovers the local Pi Agent and any installed
allow-listed CLI connectors: Claude Code, Codex CLI, Grok Build, and OpenCode.
Choose an Agent in **New project**, optionally enable an isolated Git worktree,
and start the task. CLI stdout/stderr is streamed into the conversation. On
macOS/Linux the bundled `server/pty-bridge.py` gives interactive CLIs a real
terminal; Windows and hosts without Python use the safe pipe transport. The
elapsed timer continues while you browse elsewhere, and the task remains in the
inbox after the browser is closed. Select it again to replay the bounded output
journal. CLI connectors must already be installed on the selected host; an
uninstalled connector is shown but cannot be selected.

Stepsemble launches each installed CLI inside the same local user environment.
It does not copy, export, rewrite, or upload that CLI's OAuth tokens or
subscription credentials, and it does not silently replace an official
subscription route with an API key or third-party router. You can keep using
the vendor's own client directly; both continue to use vendor-owned account
and session locations.

Pi tasks retain the full native session history. Generic CLI tasks are supervised
by an independent per-task process and stored as a private journal in
`~/.config/stepsemble/agent-tasks.json`. Restarting the Stepsemble web service
reattaches to the supervisor and keeps the task timer/output alive; if the host
or supervisor itself is killed, the journal marks the task as interrupted rather
than claiming that it is still running. The Agent Hub **View all** task center
provides search, status filters, replay, and one-tap stop controls.

Today, those generic connectors are terminal integrations: their replayable
Stepsemble journal is not yet the same thing as each vendor's full native
session, structured tool history, or approval schema. That parity is an
explicit, contract-tested milestone in the
[cross-platform plan](docs/platform-plan.md), not a current claim.

Device aliases only affect the interface. They do not rename the operating
system computer. Temporary Sub Agent sessions are hidden by default and can be
revealed from the session list when needed.

## What is included

- Responsive PWA with English as the default and ten additional locales.
- Project grouping, pinned sessions, archives, search, and three-session
  previews with Show more / Show less controls.
- Read-only project changes with changed-file counts and staged or working-tree
  diffs, optimized for both split-screen desktops and small phones.
- Resilient same-origin SSE streaming and visible failure states.
- Collapsed tool summaries with per-tool details, token use, and cost.
- Image paste/upload, inline preview, and lightbox viewing.
- Searchable provider catalog, account sign-in, API keys, custom endpoints,
  model visibility, region-specific services, and optional independent access tokens.
- Multiple-device aliases, health checks, port settings, external-drive folder
  browsing, private HTTPS relay, independent peer credentials with revocation,
  and one-time pairing.
- Read-only resource sync: compare the global Pi extensions, skills, and
  installed packages of any two devices before mirroring them yourself.
- Ink & Ivory as the default theme, plus eight additional colour systems.
- Checksum-verified stable updates that wait for active agent work to finish.

## Uninstall

```bash
~/.local/share/stepsemble-bin/uninstall.sh
```

The uninstaller asks whether to remove only Stepsemble or Stepsemble and the Pi
executable. It moves Stepsemble files to the Trash. Pi sessions, provider
credentials, and project folders are preserved in both choices.

## Local paths

| Path | Purpose |
| --- | --- |
| `~/.local/share/stepsemble` | Application release |
| `~/.local/share/stepsemble-bin` | Updater and uninstaller |
| `~/.config/stepsemble` | Web token, hash-only access tokens, device-trust grants, and update preferences |
| `~/.config/stepsemble/tokens.json` | Additional access-token hashes; mode `600` |
| `~/.local/state/stepsemble` | Local service logs and migration state |
| `~/.pi/agent` | Pi-owned sessions and credentials; not owned by Stepsemble |

Useful server environment variables are `STEPSEMBLE_PORT`, `STEPSEMBLE_HOST`,
`STEPSEMBLE_TOKEN_FILE`, `PI_HOME`, `PI_BIN`, and
`STEPSEMBLE_BROWSE_ROOTS`. A custom `STEPSEMBLE_TOKEN_FILE` must be a local file
with mode `600`; it replaces the default token path (the installer also carries
this setting into the generated services). Folder browsing defaults to the user home; add `/Volumes`
to `STEPSEMBLE_BROWSE_ROOTS` when external drives should be available. See the generic templates in [`deploy/`](deploy/)
for advanced launchd setups.

## Development

Stepsemble has no runtime npm dependencies. It uses a small Node server and a
buildless PWA so self-hosted upgrades remain easy to inspect and recover. Peer
credentials are stored in the owner-only `device-trust.json` file; only hashes
of incoming credentials are persisted, while outgoing credentials are used
only by the server relay. Optional browser access tokens are hash-only in
`tokens.json` and can be revoked by the installer token. Mermaid is bundled
locally and loaded lazily. Releases include a SHA-256 checksum and a GitHub
OIDC artifact attestation; verify the latter with `gh attestation verify`.

```bash
npm run check
npm test
```

Before making substantial changes, read the accepted
[`cross-platform architecture and execution plan`](docs/platform-plan.md), the
[`current-system inventory`](docs/current-system-inventory.md), the shipped
[`architecture`](docs/architecture.md), and the measured
[`performance baseline`](docs/performance-baseline.md), followed by
[`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md).

## Privacy

The public repository contains application code and generic templates only.
It must never include tokens, private URLs, device names, session logs,
project content, account credentials, selected-model history, or usage totals.

## License

MIT. See [`LICENSE`](LICENSE).
