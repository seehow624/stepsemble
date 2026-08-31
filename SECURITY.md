# Security policy

## Supported versions

Pi Harbor supports the latest stable release. Automatic updates follow GitHub
Releases, verify the published SHA-256 checksum, and wait for active Pi work to
finish before replacing the application.

## Reporting a vulnerability

Please use GitHub's private **Security advisories → Report a vulnerability**
flow. Do not include Web tokens, private host names, session content, provider
credentials, or project files in a public issue.

## Deployment boundary

Pi Harbor is a single-user, self-hosted interface. Keep the Node service bound
to `127.0.0.1` and use a private HTTPS gateway such as Tailscale Serve for
remote access. Do not expose port `3140` directly to the public internet.

The browser Web token is a host-level secret. Its one-time first-run reveal is
restricted to an anonymous loopback request with a loopback Host and no proxy
headers. New `PIHARBOR3` pairing uses a reviewed, five-minute capability to
issue a separate revocable peer credential; incoming hashes and outgoing
credentials are stored in `~/.config/pi-harbor/device-trust.json` with mode
`0600`. Manual URL entry is retained only for compatibility and sends the
shared Web-token cookie to that configured URL, so use it only for a host you
already trust. Prefer pairing and revoke a peer grant immediately if a device
is lost or its configuration may have been copied.

Additional access tokens are optional host-level credentials. Only the
installer/master token can issue or revoke them; each issued token is shown
once, stored only as a SHA-256 hash in `~/.config/pi-harbor/tokens.json`
(mode `0600`), and can be revoked independently. A token grants the same
single-user host access as the master token; it does not create a separate
Pi account or project permission boundary.

Release archives are checksum-verified and preflighted before extraction. The
checksum is published through the same GitHub Release as the archive and is an
integrity check, not an independent cryptographic signature.

Release workflows additionally publish GitHub artifact attestations using
short-lived OIDC signing identities. Verify an archive with the GitHub CLI:

```bash
gh attestation verify pi-harbor-vX.Y.Z.tar.gz --repo seehow624/pi-harbor
```

The attestation is supplementary to the checksum and is not required for the
local updater to install a release.

