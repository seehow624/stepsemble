# Pi Web

**Pi Web** is an open-source, mobile-first web client for the [Pi coding
agent](https://github.com/badlogic/pi-mono). It lets you browse sessions,
continue work, start projects, view image attachments, and switch between
multiple Pi Web computers from a phone or desktop browser.

**Languages:** English (default) · [Simplified Chinese](README.zh-Hans.md) ·
[Traditional Chinese](README.zh-Hant.md) · [Japanese](README.ja.md) ·
[Korean](README.ko.md) · [Turkish](README.tr.md) · [French](README.fr.md) ·
[German](README.de.md) · [Spanish](README.es.md) ·
[Brazilian Portuguese](README.pt-BR.md) · [Italian](README.it.md)

Pi Web is self-hosted. The repository contains only application code and
generic deployment templates. It does **not** contain access tokens, session
logs, project files, private URLs, account credentials, selected-model history,
usage totals, or computer-specific configuration.

## Features

- English-first PWA with optional translations.
- Collapsed work summaries that expand into individual tools and details.
- Streaming Pi RPC output over resilient same-origin SSE.
- Image paste/upload with an in-app preview and lightbox.
- Searchable model and provider management, including API-key, free, and
  account sign-in flows.
- Multiple Pi Web computers with aliases, health checks, port settings, and
  one-time pairing codes.
- Sub Agent sessions created under OS temporary folders stay hidden by default;
  the session list provides an opt-in toggle to reveal them.
- Optional macOS launchd updates from a public GitHub branch or tag.
- Ink & Ivory as the default design theme.

## Requirements

- macOS
- Node.js 20 or newer
- A working `pi` command and its normal local configuration
- Tailscale or another private HTTPS gateway for remote access

## Quick start

Run these commands on each computer that will host Pi Web:

```bash
git clone https://github.com/seehow624/pi-web.git
cd pi-web
mkdir -p ~/.config/pi-web
openssl rand -hex 32 > ~/.config/pi-web/token
chmod 600 ~/.config/pi-web/token
PI_WEB_TOKEN_FILE="$HOME/.config/pi-web/token" node server.js
```

Keep Pi Web bound to loopback. Put Tailscale Serve or another authenticated
HTTPS gateway in front of it; do not expose the Node port directly to an
untrusted network. For example, a local Tailscale Serve route can proxy an
HTTPS port to `127.0.0.1:3140`.

Open the HTTPS URL, enter the token from the local token file, and optionally
add the page to the home screen. Never commit or paste the token into an issue,
chat, screenshot, log, or public configuration file.

## Local configuration

Useful environment variables:

| Variable | Purpose |
| --- | --- |
| `PI_WEB_PORT` | Listening port (default `3140`) |
| `PI_WEB_HOST` | Bind address (default `127.0.0.1`) |
| `PI_WEB_TOKEN` | Token supplied directly; prefer a file instead |
| `PI_WEB_TOKEN_FILE` | Token file with Unix mode `600` |
| `PI_HOME` | Pi home directory when it differs from the OS home |
| `PI_BIN` | Absolute path to the Pi executable |
| `PI_WEB_BROWSE_ROOTS` | Comma-separated roots allowed in the folder picker (defaults to the Pi home; add `/Volumes` when external drives are needed) |

Pi Web reads sessions and provider settings from the normal Pi directories
under the configured home. Those directories stay outside this repository.

## Multiple computers

Install and run one local Pi Web instance on every computer that should be
available. In **Settings → Devices**, add an alias and the HTTPS URL reachable
from the current instance. Devices can also be paired with a one-time code.

Each instance should use the same Web token when it is used as a relay target.
The token is never written into the device list. A device alias changes only
what the UI displays; it does not rename the operating-system computer.

## launchd templates

The `deploy/` directory contains generic templates:

- `com.piweb.server.plist` — direct launchd service.
- `com.piweb.server.mini.plist` — optional local SSH-child launcher for hosts
  where launchd cannot reliably spawn the Pi process.
- `com.piweb.updater.plist` — hourly automatic update check.
- `pi-web-mini-start.sh` — safe launcher that waits for active work before a
  deliberate restart.

Replace `__USER__`, `__NODE__`, and `__PIBIN__` in a copied template before
installing it. Keep the application on a local filesystem rather than a
network-mounted checkout. Use your own launchd service label if you already
have one; the updater accepts `PI_WEB_SERVICE_LABEL`.

## Automatic updates

Pi Web can check the public repository on a schedule, download a verified
archive, stage it in a temporary directory, atomically swap the application,
and ask launchd to restart the service. It never changes Pi sessions, project
folders, provider credentials, or Web tokens.

Install the updater outside the application directory on each host:

```bash
mkdir -p ~/.local/share/pi-web-bin
cp deploy/pi-web-update.sh ~/.local/share/pi-web-bin/pi-web-update.sh
chmod 700 ~/.local/share/pi-web-bin/pi-web-update.sh
sed "s/__USER__/$USER/g" deploy/com.piweb.updater.plist \
  > ~/Library/LaunchAgents/com.piweb.updater.plist
launchctl bootstrap "gui/$UID" ~/Library/LaunchAgents/com.piweb.updater.plist
```

Enable **Settings → Updates → Automatic updates**. The default interval is one
hour. **Check for updates** starts an immediate check, and this command forces
one from the shell:

```bash
PI_WEB_UPDATE_FORCE=1 ~/.local/share/pi-web-bin/pi-web-update.sh
```

The repository and branch/tag can be changed with `PI_WEB_UPDATE_REPO` and
`PI_WEB_UPDATE_REF` in the LaunchAgent environment.

## Development

Pi Web intentionally has no runtime npm dependencies:

```bash
npm run check
npm test
```

Before publishing, verify that no token, private URL, machine name, account,
session, or usage data has entered the repository. Keep personal overrides in
untracked files or in the user configuration directory.

## License

MIT. See [LICENSE](LICENSE).
