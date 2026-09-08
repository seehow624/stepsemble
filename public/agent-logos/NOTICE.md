# Agent identity marks

These marks identify the conversation's agent/source, not its selected model.
They do not indicate endorsement or an enabled integration. Product names and
trademarks belong to their respective owners; Stepsemble's Apache-2.0 license
does not grant rights to third-party trademarks.

- `v1/pi.svg`: original SVG from the [Pi press kit](https://pi.dev/press-kit),
  downloaded from https://pi.dev/logo.svg on 2026-09-08. Artwork is unchanged;
  CSS compensates for the source canvas padding.
- `v1/claude.svg`, `v1/codex.svg`, `v1/grok.svg`, `v1/opencode.svg`,
  `v1/openai.svg`: unchanged SVG representations from
  [Lobe Icons](https://github.com/lobehub/lobe-icons/tree/a94750e3f5f8fc33757b839d85030e742284e43a/packages/static-svg/icons),
  pinned commit `a94750e3f5f8fc33757b839d85030e742284e43a`.
  Distributed under the [included MIT license](../vendor/licenses/lobe-icons-LICENSE.md).
- `v1/agent.svg`: Stepsemble's own neutral conversation fallback, Apache-2.0.

All assets are served locally and precached. Replacing artwork requires a new
asset directory version and corresponding CSS/service-worker updates.

Current IDs: `pi`, `claude-code`, `codex`, `opencode`, `grok-build`.
Explicit `gpt` and `chatgpt` source IDs have a presentation mapping to the OpenAI
blossom for future use; this change adds no GPT/ChatGPT connector. Model labels,
conversation titles, unknown IDs and arbitrary URLs never choose a brand mark.
