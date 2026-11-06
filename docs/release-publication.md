# Release publication

A tag build prepares a **draft**, not a publicly accepted release. Creating a
release draft, merging source, verifying artifacts, publishing, and updating an
installed App are separate operations. None waives a failed or missing check.

## Before tagging

1. Review the exact candidate and complete all applicable current-head CI gates:
   regular three-OS tests, both original rolling OS suites, the complete WebKit
   Usage job, native reader/security checks, and the native composer matrix.
   Obtain the first existing manual workflow run at that ref if path filters
   did not trigger a required matrix. Verify actual jobs and source identities,
   not a stale PR rollup or an assumed job count.
2. Integrate the accepted source without pushing its release tag. When the
   integration is a fast-forward (master becomes the exact pull-request head,
   same commit and tree), the pull-request checks already judged the commit
   that will be tagged and no second post-integration run is required. Only
   an integration that creates a new commit (a merge commit or a rebase) needs
   its own same-head checks before tagging. A failed check remains HOLD; do
   not retry unchanged source merely to obtain a green result. A job that a
   hosted runner never acquired (cancelled by the platform before any step
   ran) is infrastructure, not a verdict on the source: re-queue that job once
   and record the attempt.
3. Only then create and push the fresh annotated tag matching `package.json`.
   Do not rewrite an existing tag or alter an earlier published release.

## Verify the draft

The existing Release workflow keeps its version policy, tests, universal App
build, four assets, checksums, compatibility alias, and provenance attestation.
It uploads all four assets with `gh release create --draft`:

- `stepsemble-<tag>.tar.gz` and its `.sha256`;
- the byte-identical `pi-harbor-<tag>.tar.gz` and its `.sha256`.

Before parsing or extracting either downloaded archive, or executing any of
its contents, verify **all four** SLSA attestations: repository, tag/ref, exact
source commit, signer workflow `.github/workflows/release.yml` at that tag,
GitHub OIDC issuer `https://token.actions.githubusercontent.com`, GitHub-hosted
execution, and `--deny-self-hosted-runners`. Then verify the checksums, alias,
every tagged source blob, archive hygiene, package/App/CLI versions, App bundle
files, and universal `x86_64`/`arm64` executable using isolated owned HOME/TMP.
A draft is not public or latest acceptance; retain evidence of each state.

## Publish explicitly

Only the authorized release owner publishes after every required check and
artifact verification has actually succeeded. For a verified stable release:

```sh
gh release edit "$tag" --draft=false --prerelease=false --latest
```

For a verified prerelease, preserve its channel and never promote it to latest:

```sh
gh release edit "$tag" --draft=false --prerelease --latest=false
```

Re-read the public release, asset identities and latest/channel state. Report
publication separately from deployment: this does not install an App, restart
a Host or native service, or establish physical-device/service-worker uptake.
