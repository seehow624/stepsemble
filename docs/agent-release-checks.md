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
| Google Antigravity | `npm run -s check:antigravity-release` | the release Antigravity's update service has rolled out to 100% | the installed `agy` copied to a scratch folder and updated there with `agy update` (Antigravity publishes no download per version) | the version; the flags Stepsemble starts it with (`--effort`, `--mode`, `--add-dir`, `--dangerously-skip-permissions` among them) and the `models` command; signed out, `agy models` says so. Then, with a custom model in agy's settings pointing at a local fake Gemini API (`test-support/fake-gemini-api.mjs`), whole turns run through Stepsemble's bridge and approval gate: the stream names its conversation and answers with token usage; a command the gate denies never runs and an allowed one runs (Stepsemble starts agy without its own approval only because of this); `--conversation` continues with another model and level, which reach the model; Stop ends a turn and the next message goes on |
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

## OpenCodex maintenance

`node scripts/check-opencodex-release.mjs [version] --force` checks the npm
`latest` stable gateway in a disposable installation and HOME. It starts the
real gateway with only a localhost fake provider, checks health, complete
Codex pagination and Claude alias metadata, then drives the installed Claude
Code through Stepsemble's adapter to list and switch models and confirm the
chosen upstream model receives the request. No real account or paid model is
used. Missing installed Bun/Claude or an unavailable artifact is `wait`; a
failed interface check is `adapt`. The verdict is recorded in
`~/.config/stepsemble/opencodex-release-checks.json`. Use `--force` after a fix.

Claude aliases include current `ocx-claude-` / `ocx-claude2-` and persisted
`claude-ocx-` / `claude-ocx2-` IDs. Keep the wire ID unchanged when switching;
decode only the escaped v2 form for vendor grouping and reference pricing.
The gateway cache and companion catalog retain context and effort metadata
for both generations. Retired aliases are removed on a validated refresh.

The daily heartbeat also reads installed versions and live interfaces on Mac
Mini and MacBook Pro; a CLI found first on PATH can differ from the package
actually running the gateway. Verify `/healthz`, the service's executable
source and both model catalog formats before deciding what to update. Never
treat a version comparison or an old cached verdict as live verification.

OpenCodex upgrades use its official updater against the proven service
installation, explicitly selecting the stable `latest` tag. Both computers
must first be running a compatible released Stepsemble, and Stepsemble work
and all other gateway clients must be confirmed idle immediately before the
update. Offline, busy or unconfirmed hosts defer; never force termination.
Afterward verify the running version, health, complete catalogs and model
switching before any further upgrade. Preserve other agents' existing update
settings and intervals; never update Hermes, install an absent application,
or change credentials, routes or catalog refresh intervals.
