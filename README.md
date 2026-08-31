<p align="center">
  <img src="public/pi-logo.svg" width="112" height="112" alt="Pi Harbor Terminal Dock logo">
</p>

<h1 align="center">Pi Harbor</h1>

<p align="center">
  A calm, mobile-first harbor for your local Pi coding agent.
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-1A1A1A"></a>
  <img alt="macOS" src="https://img.shields.io/badge/platform-macOS-1A1A1A">
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

Pi Harbor is an open-source, self-hosted web interface for the
[Pi coding agent](https://github.com/badlogic/pi-mono). Browse and continue
sessions, start projects, inspect tool activity, preview images, manage models,
and move between several Pi Agent computers from a desktop or phone.

Pi Harbor is an independent community project. It is not an official Pi
product and is not affiliated with the Pi maintainers.

## Install on macOS

Run this on every computer that should host Pi Harbor:

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/pi-harbor/master/install.sh)"
```

The installer:

- detects an existing Pi Agent and offers the official Pi installer when Pi is
  missing;
- installs a private Node.js runtime only when Node 22.19 or newer is missing;
- downloads the latest GitHub Release and verifies its SHA-256 checksum;
- creates a local Web token at `~/.config/pi-harbor/token`, a launchd service, and an hourly stable-release updater;
- migrates a local v1 installation without changing Pi sessions, project
  files, provider credentials, or the existing Web token.

For a review-first installation, download the script before running it:

```bash
curl -fsSLO https://raw.githubusercontent.com/seehow624/pi-harbor/master/install.sh
less install.sh
zsh install.sh
```

Pi Harbor binds to `127.0.0.1:3140` by default. The first launch opens a short
setup guide for sign-in, devices, providers, projects, and remote access.

### Find the Web token

On the computer running Pi Harbor, open Terminal and run:

```bash
cat ~/.config/pi-harbor/token
```

From another device, retrieve the token securely from that host and paste it into
the sign-in screen. If the service was deliberately configured with
`PI_HARBOR_TOKEN_FILE`, read that configured file instead of the default path.
Never share the token in chat, screenshots, repositories, or logs.

When a browser on the host computer itself opens Pi Harbor for the first time,
a hardware-wallet-style onboarding offers to reveal the private access key
once before sign-in. It is shown only on loopback connections — never through
Tailscale Serve, a proxy, or a remote device — and only until both
acknowledgements are saved. Afterwards the reveal never appears again; other
devices always use the recorded key or the token file.

## Secure remote access

Keep the Node port private. Use Tailscale Serve or another authenticated HTTPS
gateway instead of exposing port `3140` to an untrusted network. A generic
Tailscale example is:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:3140
```

Open the HTTPS address and enter the token stored at
`~/.config/pi-harbor/token` (or the file configured by
`PI_HARBOR_TOKEN_FILE`). Optionally add the site to the home screen. Never paste
that token into an issue, chat, screenshot, log, or repository.

## Multiple computers

Each Pi Agent computer runs its own Pi Harbor instance. Install and run Pi Harbor
on every host, then use **Settings → Devices → Add device** to add a Tailscale or
HTTPS address. Manual URL entry remains the legacy shared-Web-token path and
requires the same Web token on both hosts. Prefer a five-minute `PIHARBOR3`
one-time pairing code: after you review the candidate details, it provisions an
independent, revocable peer credential and never sends the shared token to the
candidate. Authorized peer grants can be listed and revoked in Device settings;
revocation takes effect immediately. Pi Harbor 2.2 accepts `PIHARBOR2` codes
from 2.1.2 hosts, while older clients must update before using `PIHARBOR3`.
Keep port `3140` private and do not expose it to an untrusted network.

To add an LLM provider, open **Settings → Connection → Models & providers**.
Choose a catalog service, account/OAuth sign-in, API key, local service, or
Custom provider. Then select the visible models you want to use.

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
  model visibility, and region-specific services.
- Multiple-device aliases, health checks, port settings, external-drive folder
  browsing, private HTTPS relay, independent peer credentials with revocation,
  and one-time pairing.
- Ink & Ivory as the default theme, plus eight additional colour systems.
- Checksum-verified stable updates that wait for active Pi work to finish.

## Uninstall

```bash
~/.local/share/pi-harbor-bin/uninstall.sh
```

The uninstaller asks whether to remove only Pi Harbor or Pi Harbor and the Pi
executable. It moves Pi Harbor files to the Trash. Pi sessions, provider
credentials, and project folders are preserved in both choices.

## Local paths

| Path | Purpose |
| --- | --- |
| `~/.local/share/pi-harbor` | Application release |
| `~/.local/share/pi-harbor-bin` | Updater and uninstaller |
| `~/.config/pi-harbor` | Web token, device-trust grants, and update preferences |
| `~/.local/state/pi-harbor` | Local service logs and migration state |
| `~/.pi/agent` | Pi-owned sessions and credentials; not owned by Pi Harbor |

Useful server environment variables are `PI_HARBOR_PORT`, `PI_HARBOR_HOST`,
`PI_HARBOR_TOKEN_FILE`, `PI_HOME`, `PI_BIN`, and
`PI_HARBOR_BROWSE_ROOTS`. A custom `PI_HARBOR_TOKEN_FILE` must be a local file
with mode `600`; it replaces the default token path (the installer also carries
this setting into the generated services). Folder browsing defaults to the Pi home; add `/Volumes`
to `PI_HARBOR_BROWSE_ROOTS` when external drives should be available. See the generic templates in [`deploy/`](deploy/)
for advanced launchd setups.

## Development

Pi Harbor has no runtime npm dependencies. It uses a small Node server and a
buildless PWA so self-hosted upgrades remain easy to inspect and recover. Peer
credentials are stored in the owner-only `device-trust.json` file; only hashes
of incoming credentials are persisted, while outgoing credentials are used
only by the server relay. Release signing remains future work. The runtime
Mermaid CDN is a known offline/privacy follow-up.

```bash
npm run check
npm test
```

Read [`docs/architecture.md`](docs/architecture.md),
[`CONTRIBUTING.md`](CONTRIBUTING.md), and [`SECURITY.md`](SECURITY.md) before
making substantial changes.

## Privacy

The public repository contains application code and generic templates only.
It must never include tokens, private URLs, device names, session logs,
project content, account credentials, selected-model history, or usage totals.

## License

MIT. See [`LICENSE`](LICENSE).
