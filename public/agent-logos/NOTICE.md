# Agent identity marks

These marks identify the conversation's agent/source, not its selected model.
They do not indicate endorsement or an enabled integration. Product names and
trademarks belong to their respective owners; Stepsemble's Apache-2.0 license
does not grant rights to third-party trademarks.

## v2 (current)

Each mark is drawn in its own colours and looks the same in light and dark;
the interface never tints it. Marks that come as an app icon carry their own
tile.

- `v2/pi.svg`: the official colour logo from the [Pi press kit](https://pi.dev/press-kit),
  downloaded from https://pi.dev/logo.svg on 2026-10-21. Artwork is unchanged;
  CSS compensates for the source canvas padding.
- `v2/claude-code.svg` (Claude Code's Clawd), `v2/claude.svg`, `v2/codex.svg`
  (the Codex app icon) and `v2/antigravity.svg`: unchanged colour SVGs from
  [Lobe Icons](https://github.com/lobehub/lobe-icons), npm
  `@lobehub/icons-static-svg@1.97.0` (`claudecode-color`, `claude-color`,
  `codex-color`, `antigravity-color`). Distributed under the
  [included MIT license](../vendor/licenses/lobe-icons-LICENSE.md).
- `v2/grok.svg`, `v2/hermes.svg`, `v2/openai.svg`: the Lobe Icons 1.97.0 marks
  (`grok`, `hermesagent`, `openai`) placed on the tile of their products' own
  icons: Grok's #FCFCFC on #050505 (grok.com), Hermes Agent's black on white
  (hermes-agent.nousresearch.com), and the OpenAI blossom black on white.
  MIT, as above.
- `v2/opencode.svg`: the official app icon, `packages/ui/src/assets/favicon/favicon-v3.svg`
  from [sst/opencode](https://github.com/sst/opencode), without its wrapper.
  Distributed under the [included MIT license](../vendor/licenses/opencode-LICENSE.txt).
- `v2/omp.svg`: the official icon from https://omp.sh/favicon.svg
  ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)), unchanged.
  Distributed under the [included MIT license](../vendor/licenses/oh-my-pi-LICENSE.txt).
- `v2/cline.svg`: the filled bot from the official
  [Cline brand assets](https://cline.bot/brand) (`cline-icon-dark.svg`), in
  #FCFCFD on the #282524 tile of the official `APP_ICON_DARK_fill.png`, at its
  size and place there.
- `v2/kilo.svg`: the official icon from https://kilo.ai/favicon/favicon.svg,
  unchanged.
- `v2/minimax.png`: unchanged from `v1/minimax.png`.
- `v2/agent.svg`: Stepsemble's own neutral conversation fallback in one fixed
  grey, Apache-2.0.

## v1 (kept for clients from before 3.9.41)

- `v1/pi.svg`: original SVG from the Pi press kit, downloaded from
  https://pi.dev/logo.svg on 2026-09-08.
- `v1/claude.svg`, `v1/codex.svg`, `v1/grok.svg`, `v1/opencode.svg`,
  `v1/openai.svg`: unchanged SVG representations from Lobe Icons, pinned commit
  `a94750e3f5f8fc33757b839d85030e742284e43a`, MIT.
- `v1/antigravity.svg`, `v1/cline.svg`, `v1/kilo.svg`, `v1/hermes.svg`,
  `v1/omp.svg`: Stepsemble's original source-neutral marks, not official logos.
- `v1/agent.svg`: Stepsemble's own neutral fallback, Apache-2.0.

All assets are served locally and precached. Replacing artwork requires a new
asset directory version and corresponding CSS/service-worker updates; an
earlier directory stays for clients that still name it.

Current IDs: `pi`, `claude-code`, `codex`, `opencode`, `grok-build`, `antigravity`,
`cline`, `kilo`, `hermes`, `omp`.
Explicit `gpt` and `chatgpt` source IDs have a presentation mapping to the OpenAI
blossom for future use; this change adds no GPT/ChatGPT connector. Model labels,
conversation titles, unknown IDs and arbitrary URLs never choose a brand mark.
