# B+ vector brand refresh

Status: source, browser, rolling compatibility and three-OS CI validation
passed for 3.0.7-rc.2. Production Hosts remain on 3.0.6.

Jerome approved the B+ direction on 2026-09-07 after comparing the previous
mark with A, B, D, the B+ generated study and an exact-size review board. The
generated bitmap was not promoted. Its proportions were rebuilt as reusable
vector geometry.

## Canonical construction

- `public/stepsemble-mark.svg` is the colour master.
- The canvas and rotation centre are 1254 × 1254 and 627,627.
- One module and one blue-violet connector are reused at 0°, 90°, 180° and
  270°. The standard group uses scale 0.92 and equal 16% optical margins.
- `public/stepsemble-glyph.svg` is the transparent single-colour mask source.
- `public/stepsemble-maskable.svg` uses scale 0.82 so operating-system masks do
  not crop the outer shape.

## Runtime assets

- `stepsemble-mark.png`: 1254 px opaque RGB README/source raster.
- `icon-512.png` and `icon-180.png`: standard opaque RGB icons.
- `icon-32.png` and `icon-16.png`: dedicated favicon sizes.
- `icon-maskable-512.png`: independent opaque RGB PWA maskable icon.
- `stepsemble-glyph.png`: 512 px transparent RGBA UI/notification mask.

The manifest advertises standard and maskable icons separately. The service
worker precaches every browser-facing derivative, and tests pin the canonical
SVG and raster hashes.

## Local validation

- Full Node test suite: 346 tests, 344 passed, two expected platform skips and
  zero failures.
- Independent Draft 2020-12 protocol conformance: 1,251 cases passed.
- Fresh isolated Host: B+ visually checked on the access-key page, sign-in
  page, onboarding, persistent workspace header and empty-session state.
- Desktop and 390 × 844 responsive viewport checks retained recognisable
  spacing and silhouette at both display and favicon-scale UI sizes.
- `git diff --check` passed. Production services were not restarted.

## GitHub gates

- Brand commit `cff95ee`: rolling browser compatibility run `34047303481`
  passed on macOS and Ubuntu against both shipped releases.
- Its first CI run `34047303544` passed macOS and Ubuntu; Windows exposed only
  a text-checkout CRLF mismatch in the new SVG integrity assertion, not an
  artwork or runtime failure.
- Follow-up `b758285` normalises SVG line endings before hashing. CI run
  `34047425379` then passed macOS, Ubuntu and Windows, including JavaScript,
  typed-client, protocol artifact, independent schema conformance and the full
  Node test suite.

## Boundaries

This change does not log in to a provider, call a model, modify native session
history or restart a Host. The active 72-hour reliability run remains pinned to
clean `ab227af` / runtime `2b7f0b6`; its result must not be described as testing
this later brand/version commit. Source CI, browser rendering and release gates
for rc.2 must be reported separately before any deployment or stable release.
