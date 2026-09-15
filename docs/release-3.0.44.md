# Stepsemble 3.0.44 validation

Date: 2026-09-16. This record distinguishes local implementation tests,
official executable checks, and authenticated production inference.

## Completed before release

- Shared installed defaults cover both new launchers and old automatic
  update launch commands. Explicit native opt-outs remain authoritative.
- HTTP tests cover model/context endpoints, image-only prompts, input bounds,
  exact session/thread scope, stale-tab refusal and asynchronous responses.
- Claude Code 2.1.270 acknowledged official stream-json `initialize` and
  `set_model` controls and returned five models. No user prompt was sent.
- The installed official Codex 0.154.0 executable passed the isolated composer
  oracle, using a temporary HOME and a localhost mock Responses endpoint.
  It forwarded a 1,200,090-byte PNG, `mock-model`, and `high` reasoning; the
  native usage notification reported 26 current-turn tokens and 258,400
  capacity. Exactly one local mock request, zero paid requests; process and
  temporary fixture cleanup confirmed.
- Mobile-sized browser testing at 390 x 844 verified Codex model/effort
  selection and transmitted request fields, Claude model acknowledgement and
  text sending, and unknown context displayed without a fabricated percentage.
  The final Claude model sheet hides unsupported reasoning controls.
- Client build/artifact check, canonical protocol build, 1,251 independent
  schema conformance cases, version consistency and syntax checks passed.
- Full local suite: 1,355 passed, 4 skipped, 0 failed.

## Reproduce

```sh
npm run check
npm run check:native:composer
npm run check:client
npm run check:protocol
npm run check:protocol:conformance
npm run version:check
npm test
node scripts/check-native-codex-composer.mjs /absolute/path/to/official/codex
node scripts/native-composer-preview.mjs
```

The native composer oracle requires the reviewed official 0.154.0 executable.
The browser fixture is synthetic, listens only on loopback, and does not call
providers or expose private histories. Its printed token is test-only.

## Explicit remaining verification boundaries

- Production Claude credential helpers reported signed out on both Macs.
  Successful controls do not prove subscription authentication or inference;
  the user must finish official sign-in on each intended host before a real
  Claude response can be verified. No credential or subscription setting was
  changed by the tests.
- The browser extension denied automated file selection. Backend image
  serialization and real Codex transport are verified; the mobile device's
  photo-picker-to-provider path still needs a manual device test.
- Native Codex mutation remains restricted to reviewed versions and one
  active thread per native transport. Stale tabs fail closed rather than
  sending to or interrupting a different thread.
- No new 72-hour soak was started, and this release does not claim arbitrary
  future harness versions or all platforms are fully native-feature equivalent.
