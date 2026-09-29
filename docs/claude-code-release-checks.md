# Checking a new Claude Code release

Claude Code updates itself and is released every few days, and Stepsemble
relies on more of it than its message format: the model and effort it sends,
the usage it reports, commands that run for a long time, Stop, resuming a
conversation, branching one, and the transcript it writes under
`~/.claude/projects`, which Stepsemble reads to reopen a conversation and to
find where a branch ends. Claude Code 2.1.281 broke one of these: it reported
the progress of a long command with an event Stepsemble did not know, and the
conversation was stopped.

`npm run -s check:claude-release [version]` checks the newest release (or the one
named) once:

- it downloads the official npm artifact for this platform
  (`@anthropic-ai/claude-code-<platform>@<version>`);
- it runs `scripts/check-native-claude-release.mjs` against it, which drives the real
  CLI through the Host's own adapter (`server/claude-code-structured-adapter.js`)
  in an owned HOME, with a localhost fake Anthropic API and an API key only
  the fake accepts: no account and no paid request;
- it keeps the verdict in `~/.config/stepsemble/claude-release-checks.json`, so
  a release that passed is not checked again (`--force` checks it anyway).

The checks: the model and effort chosen are the ones sent and change mid-way;
the usage of a turn is read as it ends; a picture reaches the model; a command
running past 30 seconds finishes; Stop ends a turn and the conversation goes
on; a closed conversation resumes with its history; a branch through the first
reply carries that reply only and leaves the original unchanged; the
transcript reads back as the conversation (`claudeMessages`) and the branch point
is found in it (`server/claude-fork-point.js`, shared with the Host).

It prints one JSON object: `action: "none"` when the release passed, `"adapt"` with
the failed check when it did not (exit code 2), `"wait"` when it could not be
checked. The fake model (`test-support/fake-anthropic-api.mjs`, shared with the
Grok Build and Pi checks) answers by marker (`Reply with exactly: X`,
`USAGE-TEST`, `SLOW-n`, `TOOL-SLEEP`, `TOOL-ECHO`, `TOOL-WRITE`) and skips the
system messages an agent inserts in the conversation.
