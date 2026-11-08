# Agent identity marks

These marks identify the conversation's agent/source, not its selected model.
They do not indicate endorsement or an enabled integration. Product names and
trademarks belong to their respective owners; Stepsemble's Apache-2.0 license
does not grant rights to third-party trademarks.

## v2 (current)

Each mark is drawn in its own colours; the interface never tints it. Marks
that come as an app icon carry their own tile. Codex's app icon comes in light
and dark: Stepsemble shows the one that matches its theme (the system's on a
page that follows the system).

- `v2/pi.svg`: the official colour logo from the [Pi press kit](https://pi.dev/press-kit),
  downloaded from https://pi.dev/logo.svg on 2026-10-21. Artwork is unchanged;
  CSS compensates for the source canvas padding.
- `v2/claude-code.svg` (Claude Code's Clawd), `v2/claude.svg`, `v2/codex.svg`
  (the Codex app icon) and `v2/antigravity.svg`: unchanged colour SVGs from
  [Lobe Icons](https://github.com/lobehub/lobe-icons), npm
  `@lobehub/icons-static-svg@1.97.0` (`claudecode-color`, `claude-color`,
  `codex-color`, `antigravity-color`). Distributed under the
  [included MIT license](../vendor/licenses/lobe-icons-LICENSE.md).
- `v2/codex-dark.svg`: the Lobe Icons `codex-color` mark above (unchanged in
  1.102.0) on the tile of the Codex app's dark icon (#303131 to #141414, with
  its lighter top rim), its prompt (`>_`, cut out of the mark) drawn in the
  dark icon's light #E4E6FF. Colours read from the dark icon the ChatGPT app
  for macOS ships (26.1103); none of that app's artwork is included. MIT, as
  above.
- `v2/grok.svg`, `v2/openai.svg`: the Lobe Icons 1.97.0 marks (`grok`,
  `openai`) placed on the tile of their products' own icons: Grok's #FCFCFC on
  #050505 (grok.com), and the OpenAI blossom black on white.
  MIT, as above.
- `v2/opencode.svg`: the official app icon, `packages/ui/src/assets/favicon/favicon-v3.svg`
  from [sst/opencode](https://github.com/sst/opencode), without its wrapper.
  Distributed under the [included MIT license](../vendor/licenses/opencode-LICENSE.txt).
- `v2/minimax.png`: unchanged from `v1/minimax.png`.
- `v2/agent.svg`: Stepsemble's own neutral conversation fallback in one fixed
  grey, Apache-2.0.

## v1 (kept for clients from before 3.9.41)

- `v1/pi.svg`: original SVG from the Pi press kit, downloaded from
  https://pi.dev/logo.svg on 2026-09-08.
- `v1/claude.svg`, `v1/codex.svg`, `v1/grok.svg`, `v1/opencode.svg`,
  `v1/openai.svg`: unchanged SVG representations from Lobe Icons, pinned commit
  `a94750e3f5f8fc33757b839d85030e742284e43a`, MIT.
- `v1/antigravity.svg`: Stepsemble's original source-neutral mark, not an
  official logo.
- `v1/agent.svg`: Stepsemble's own neutral fallback, Apache-2.0.

All assets are served locally and precached. Replacing artwork requires a new
asset directory version and corresponding CSS/service-worker updates; an
earlier directory stays for clients that still name it.

Current IDs: `pi`, `claude-code`, `codex`, `opencode`, `grok-build`, `antigravity`.
The Cline, Kilo Code and Oh My Pi marks were removed in 3.10.10; a stored
conversation with one of those ids shows the neutral fallback.
Explicit `gpt` and `chatgpt` source IDs have a presentation mapping to the OpenAI
blossom for future use; this change adds no GPT/ChatGPT connector. In Limits the
allowance Codex reads is the ChatGPT subscription's, shown as ChatGPT with the
blossom. Model labels,
conversation titles, unknown IDs and arbitrary URLs never choose a brand mark.
