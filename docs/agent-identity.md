# Agent identity in conversation chrome

2026-09-08 · development candidate **3.0.7-rc.4**, not a production deployment.

## Identity rule

The logo identifies the conversation's harness/source. It never comes from a
model name, provider routing, conversation title, executable path or remote URL.
Pi using a Claude/GPT model remains Pi; Codex using GPT remains Codex.

| Source ID | Label / artwork |
| --- | --- |
| `pi` | Pi Agent / Pi official pixel mark |
| `claude-code` | Claude Code / Claude star |
| `codex` | Codex / Codex mark, distinct from the OpenAI blossom |
| `opencode` | OpenCode / OpenCode frame |
| `grok-build` | Grok Build / Grok mark |
| `gpt`, `chatgpt` | GPT, ChatGPT / OpenAI blossom; presentation only, no new connector |
| anything else | neutral conversation mark |

`client/agent-identity.ts` builds the shared inert DOM badge; its generated JS is
used unchanged by the browser and Node tests. SVG provenance and the MIT notice
are in [`public/agent-logos/NOTICE.md`](../public/agent-logos/NOTICE.md).

## Surfaces and behavior

- Existing Pi session rows, Agent Hub chips/tasks, task center and chat heading.
- Only the known Pi sessions endpoint defaults a missing legacy `agentId` to Pi.
- Existing task status dots remain separate overlays; text still states status
  and source. Header icons have accessible names; decorative list icons do not
  duplicate the adjacent source text. Titles remain plain native/session titles.
- Fixed 28 px badges / 20 px marks, smaller chips, current-color light/dark
  styling and forced-colors support. No animations or new dependencies.
- Fixed local assets in `agent-logos/v1`; all marks and the helper/CSS are in the
  versioned service-worker shell. No third-party per-row image requests.
- The composer uses a neutral localized prompt instead of labeling every agent
  as Pi. Stepsemble's own approved B+ artwork is unchanged.

## Verification

- Node 22.22.3: 646 tests, 644 pass / 2 platform skips / 0 failures.
- Strict TypeScript generation/artifact check, version synchronization and syntax
  checks passed. Regression tests cover source IDs, prototype/URL/model-name
  fallback, accessible inert DOM, offline assets and chat identity clearing.
- Existing CI Pi browser cases assert list/Hub/header identity without changing
  session titles or rebuilding the selected row.
- Local GUI verification used Codex Computer Use against an owned synthetic
  actual Host: 390 px dark / 320 px light, no horizontal overflow; five task
  marks including unknown fallback; task-center alignment; Claude→Codex header
  updates and reload. This is browser emulation, not iOS/Android device testing.
- Repeat with `node scripts/agent-identity-preview.mjs`; the fixed printed key
  belongs only to that loopback synthetic fixture. Ctrl-C stops that owned Host
  and removes only its generated temporary records. Never point it at user data.

## Deliberate limits

This does not add native history discovery, a GPT/ChatGPT connector, per-message
avatars, approval/resume parity or a new history catalog schema. The separate
Claude read-only history trial remains unchanged. Automatic multi-agent history
discovery is still subsequent work in the platform plan. No account, router,
production service, release tag or fixed-source 72-hour soak was changed.
