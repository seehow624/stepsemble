# Stepsemble 3.0.73 — authoritative model catalogs

## Source ownership

Supported Pi built-ins now discover their live roster from fixed official model
endpoints. OpenCode Go, Zen and OpenRouter use public endpoints without credentials.
Developer API-key discovery also supports OpenAI, Anthropic, Gemini, DeepSeek,
Groq, Mistral, xAI, Cerebras, Moonshot and NVIDIA. Endpoints are code-owned;
redirects are rejected, response bodies/rows/pages are bounded, upstream error
bodies are never returned, and keys never reach the Pi catalog service.

Subscription OAuth, credential shell commands, unknown destinations, and manually
overridden providers are not repurposed into developer API credentials. Existing
automatic preset discovery remains in place. No key, login, route switch or
conversation is rewritten by this release.

Pi's public catalog enriches exact-model metadata and is the first-use fallback
when the official endpoint fails. Once an official roster has succeeded, an
outage keeps that roster instead of resurrecting directory-only rows. Valid empty
official lists remove old models; malformed or incomplete pages never do. Model
names lose obsolete parenthesized billing multipliers, not identity information.
Unknown new models use conservative runtime defaults (text, no asserted thinking,
32K context cap / 4K output unless reported); the public picker reports unknown
capacity, not a verified 32K specification. Discovery is not proof of inference
compatibility, billing entitlement, or support for every future protocol.

The five-minute TTL/background checks and explicit check remain. Provider headers
now show source, last successful check and stale fallback. Availability still
depends on what upstream actually publishes. Not every provider has a discovery
API, and there is no zero-delay push guarantee.

## OpenCodex

Codex's model route reads the gateway only when `openai_base_url` exactly matches
the configured local OpenCodex origin. Direct mode stays native. Gateway pagination
is separate from native cursors and the gateway's effort/image/context metadata
takes precedence. Discovery is cached for five minutes and failures retain its
own last good data. No generic custom proxy is mistaken for OpenCodex.

Claude model reads refresh the gateway companion cache. The adapter rebuilds
aliases from it even after initialization, so additions, names, removals and
effort declarations no longer freeze at session start. An explicit no-effort
gateway model no longer inherits the base Claude model's capabilities. Existing
model selection and messages are preserved. Host-owned settings/cache schemas
remain compatible; Claude's own login/settings files are not edited.

## Verification

- Full local suite: 1,495 passed, 4 skipped, 0 failed (1,499 tests).
- Syntax, client build artifact and protocol artifact checks pass.
- `scripts/check-pi-catalog-refresh.mjs`: real installed Pi, isolated fixture,
  official-discovered model reaches registry and can be selected after reload;
  zero messages / zero inference.
- Actual official reads: Go returned 37 models and OpenRouter 446; Go contains
  DeepSeek V4.1 Flash and the correct GLM-5.3-Flash name.
- Actual local OpenCodex read: 17 Codex-facing models, live reasoning levels and
  `source: opencodex`; no prompt or configuration mutation.
- Chrome isolated-host UI: 37 Go models, `Provider API` timestamp, correct GLM
  name and Qwen Plus text. Preview uses a fake key and no model inference.

The official Go endpoint also lists some legacy IDs missing from Pi's directory,
including Omen Alpha. Its absence from Pi alone was not proof of retirement;
this release follows the official roster instead of that inference.
