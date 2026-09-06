# Open-source licensing and publication

## Project license

On 2026-09-06 the repository owner chose to publish Stepsemble under the
Apache License, Version 2.0. The authoritative text is [`LICENSE`](../LICENSE),
with project attributions in [`NOTICE`](../NOTICE) and SPDX identifier
`Apache-2.0` in `package.json`.

The complete license text comes from the
[Apache Software Foundation](https://www.apache.org/licenses/LICENSE-2.0.txt).
Original MIT notices for Stepsemble, Pi Harbor, and Pi Web are retained in
[`licenses/legacy-MIT.txt`](../licenses/legacy-MIT.txt). Previously distributed
MIT versions remain available under their original terms; existing tags and
release archives are not rewritten. Vendored code retains its upstream
licenses and notices, including Marked, DOMPurify, and Mermaid; see
[`public/vendor/THIRD-PARTY-NOTICES.md`](../public/vendor/THIRD-PARTY-NOTICES.md).
Separately installed coding agents are not relicensed by Stepsemble.

`package.json` retains `private: true` to prevent accidental npm publication.
That flag does not control GitHub repository visibility or the source license.

## Pre-publication checks

The 2026-09-06 check covered all 120 Git commits then present, 166 available
Actions log archives, and 58 distinct release archives. Alternate v3 asset
names had matching GitHub SHA-256 digests. No Actions artifacts, issues, wiki,
Pages site, or forks were present. Automated secret scans and additional checks
for the current Web credential, private-key headers, private hostnames, and
private-state filenames returned no findings in the inspected material.

This is a bounded publication check, not a guarantee that all security defects,
personal information, or third-party licensing questions have been eliminated.
Scans must be repeated for new material. Do not commit credentials, actual
session data, private machine configuration, or unredacted diagnostics.

## Update channel

Repository visibility and a release are separate operations. Making the
repository public lets the existing updater read its release metadata and
assets without a GitHub credential. It does not promote a development version
to stable. At this transition the latest stable release remains v3.0.3 (MIT),
while the owner's Mini is locally running 3.0.4-rc.3. Apache-2.0 applies to the
updated source distribution, not a silently modified v3.0.3 archive.
