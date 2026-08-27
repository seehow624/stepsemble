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

