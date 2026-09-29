# Checking a new Pi release

Pi is released often, and Stepsemble relies on its RPC mode, on its extension
interface (the Host loads `server/pi-catalog-extension.mjs` into every Pi it
starts), on its session files (a conversation resumes from its file and
branches with Pi's own session code in `server/pi-branch.mjs`), and on the
usage `get_session_stats` reports.

`npm run -s check:pi-release [version]` checks the newest release (or the one
named) once:

- it installs the official npm package (`@earendil-works/pi-coding-agent@<version>`)
  into a scratch folder with no install scripts, and records its integrity;
- it runs `scripts/check-native-pi-release.mjs` against the package's `pi`
  command, started as the Host starts it (`--mode rpc` with Stepsemble's
  extension), in an owned agent folder whose `models.json` points two models
  at a localhost fake Anthropic Messages API, with a key only the fake accepts:
  no account and no paid request;
- it keeps the verdict in `~/.config/stepsemble/pi-release-checks.json`, so a
  release that passed is not checked again (`--force` checks it anyway).

The checks: Stepsemble's extension loads and its command reloads the model
list without calling the model; the model and thinking level chosen are the
ones sent, and the level changes mid-way; a turn's usage adds up in
`get_session_stats` as the dashboard reads it; a picture reaches the model;
Stop ends a turn and the conversation goes on; a command the model calls runs;
a closed conversation resumes from its file with its history, model and level;
a branch after the first reply carries that turn only and leaves the original
file unchanged.

It prints one JSON object: `action: "none"` when the release passed, `"adapt"`
with the failed check when it did not (exit code 2), `"wait"` when it could not
be checked. `scripts/check-native-pi.mjs` stays as it was: an offline check of
the RPC frames of Pi 0.84.2 against a reviewed fixture.
