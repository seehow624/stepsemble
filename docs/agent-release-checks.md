# Agent release checks

Stepsemble installs an agent release only when it supports it. For Codex that
is decided by comparing contracts (`docs/codex-compatibility-runtime.md`).
Every other agent Stepsemble upgrades has a release check that runs the real
release, in a scratch folder with an owned HOME, through Stepsemble's own
adapter for that agent. No account is used and no paid model request is made.

| Agent | Command | Stable release read from | Candidate | What is checked |
| --- | --- | --- | --- | --- |
| Claude Code | `npm run -s check:claude-release` | npm tag `stable` | the official platform package | a full conversation with a local fake model (`docs/claude-code-release-checks.md`) |
| Grok Build | `npm run -s check:grok-release` | `https://x.ai/cli/stable` | xAI's build for this platform | a full conversation with a local fake model (`docs/grok-build-release-checks.md`) |
| Pi | `npm run -s check:pi-release` | npm tag `latest` | the npm package | a full conversation with a local fake model (`docs/pi-release-checks.md`) |
| OpenCode | `npm run -s check:opencode-release` | npm tag `latest` of `opencode-ai` | the platform build from npm | the Host's managed `opencode serve` and client: health and version; a conversation created, listed, named and read; a message answered by a local fake model (the anthropic provider pointed at it); status; a branch |
| Google Antigravity | `npm run -s check:antigravity-release` | the release Antigravity's update service has rolled out to 100% | the installed `agy` copied to a scratch folder and updated there with `agy update` (Antigravity publishes no download per version) | the version; the flags Stepsemble starts it with and the `models` command; signed out, `agy models` says so; signed out, a stream-json run ends in a result event the Host's parser reads with nothing left unread. Antigravity cannot be pointed at a fake model, so no conversation is answered |
| Cline, Kilo Code, Oh My Pi | `npm run -s check:acp-release -- <cline\|kilo\|omp>` | npm tag `latest` | the npm package (Oh My Pi's runs on Bun) | the Host's ACP adapter: the agent answers initialize; a new conversation opens (Kilo, with its models and modes) or, signed out, is answered with a sign-in request the Host reads as such (Cline, Oh My Pi); the agent stops cleanly |

`npm run -s check:agent-releases` runs all of them, one after another, and
prints one JSON object: `action` is `adapt` when a release failed a check,
`wait` when one could not be checked, `none` when all passed.

Each check keeps its verdict per release in
`~/.config/stepsemble/<name>-release-checks.json` (claude, grok, pi, opencode,
antigravity, cline, kilo, omp) with the Stepsemble version that made it. A
release that passed is not checked again (`--force` checks it anyway). Only
stable releases are checked: a version with anything after its three numbers
is refused.

## Before an upgrade

The Host reads the same files before it upgrades an agent, by hand or
automatically (`server/agent-release-gate.js`):

- passed: the release is installed, and an updater that can be given a
  version installs exactly that one;
- failed in this Stepsemble: the release waits. The daily check finds it,
  Stepsemble is changed for it and released, and the Hosts update themselves;
- failed in an older Stepsemble, or never checked: the Host runs the check in
  the background, one at a time, and installs the release about 30 seconds
  after it passes. A check that could not run is tried again after an hour.

So each Host checks a release itself, on the platform it runs on, before the
release reaches it.
