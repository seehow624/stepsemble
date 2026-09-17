# Installing the official Codex CLI on the MacBook Pro

## Why

The MacBook Pro resolves `codex` to `/opt/homebrew/bin/codex`, which is
OpenCodex's autostart shim rather than a Codex installation. It renamed the
original launcher to `/opt/homebrew/bin/codex.opencodex-real`, which points at
`/Applications/ChatGPT.app/Contents/Resources/codex`.

Stepsemble reports that executable's source as unknown and refuses to update
it. That refusal is correct: overwriting a third-party shim would break
OpenCodex's configuration. The consequence is that the MacBook Pro stays on
Codex 0.146.0, whose schema is too old for native model switching and
approvals, so that host falls back to the legacy connector.

The Mac Mini has the same OpenCodex shim at the same path and works normally,
because its `PATH` selects `~/.local/bin/codex` first — an official standalone
install. The two coexist there.

## Steps, run on the MacBook Pro

Install the official CLI. This is the installer documented at
<https://developers.openai.com/codex/cli>:

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Open a new terminal, then confirm `codex` now resolves to the official install
rather than the shim:

```sh
whence -p codex
codex --version
```

Expect `/Users/jerometeng/.local/bin/codex` and a 0.154.x version. The Mac Mini
resolves the equivalent path to
`~/.codex/packages/standalone/current/bin/codex`.

If `whence -p codex` still reports `/opt/homebrew/bin/codex`, `~/.local/bin` is
not ahead of `/opt/homebrew/bin` in that shell's `PATH`. Add it in `~/.zprofile`
rather than editing or removing the shim:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Restart Stepsemble's service on that host so it re-resolves the command, then
check the Codex row in harness updates. A successful result reports the
standalone version with source `official-standalone`.

## What this does not do

- It does not remove, edit or disable OpenCodex's shim. Both remain installed,
  as they already do on the Mac Mini.
- It does not change how Stepsemble proves an install source. The Codex row
  becomes updatable because the resolved executable is now an official
  standalone install, not because any check was relaxed.
- `codex.opencodex-real` and `~/.opencodex/codex-shim.json` are left untouched,
  so `ocx codex-shim uninstall` still works if you later want to remove the
  shim.
