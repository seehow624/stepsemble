# Checking a new Grok Build release

Grok Build updates itself, and Stepsemble relies on more of it than the ACP
messages it speaks over `grok agent stdio`: the model and reasoning level it
sends, the usage it reports on each reply, pictures, Stop, the permission it
asks before running a command, and loading a conversation again after a
restart.

`npm run -s check:grok-release [version]` checks the newest release (or the one
named) once:

- it reads the version on xAI's stable channel (`https://x.ai/cli/stable`) and
  downloads the build for this platform from where xAI's installer gets it
  (`https://x.ai/cli/grok-<version>-<platform>`, then the Google Cloud Storage
  copy); xAI publishes no checksum, so the SHA-256 of the download is recorded;
- it runs `scripts/check-native-grok-release.mjs` against it, which drives the
  real CLI through the Host's own adapter (`server/grok-acp-adapter.js`) in an
  owned HOME whose `~/.grok/config.toml` points two models at a localhost fake
  Anthropic Messages API, with keys only the fake accepts: no account and no
  paid request;
- it keeps the verdict in `~/.config/stepsemble/grok-release-checks.json`, so a
  release that passed is not checked again (`--force` checks it anyway).

The checks: the model and reasoning level chosen are the ones sent, and the
level changes mid-way; the usage of a turn reads from Grok's reply as the
dashboard reads it (`acpUsageStats`); a picture reaches the model; Stop ends a
turn with `stopReason: "cancelled"` and the conversation goes on; a command
that writes a file asks for permission first and runs once allowed; a closed
conversation loads again with its history (`session/load`) and goes on.

It prints one JSON object: `action: "none"` when the release passed, `"adapt"`
with the failed check when it did not (exit code 2), `"wait"` when it could not
be checked.

Two things Grok does that the checks account for: it drops a picture smaller
than 8 pixels a side or 512 pixels in all before the model sees it, so the
test picture is 32×32; and for a model that is not xAI's own it names a call's
cache writes only in the turn's sum (`_meta.usage`), which Stepsemble reads when
the turn was one call.
