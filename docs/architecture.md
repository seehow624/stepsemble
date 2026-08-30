# Pi Harbor architecture

Pi Harbor intentionally remains a dependency-free Node/PWA application. The
runtime is local to each Pi Agent computer, so the app must continue to work
without a build server and must keep launchd, Tailscale, SSE, and the updater
simple.

## Boundaries

```text
server.js
  ├─ Pi/session/provider/device behavior and route table
  ├─ server/device-trust.js  one-time pairing, peer credentials, and atomic grants
  └─ server/http-utils.js  HTTP headers, cookies, auth modes, JSON bodies, SSE framing

public/index.html
  ├─ public/i18n.js
  ├─ public/modules/app-foundation.js  settings, themes, device helpers
  ├─ public/modules/session-utils.js   pure session display helpers
  └─ public/app.js                     view controller and feature flows
```

The small modules are loaded as ordinary browser scripts rather than bundled
by Next.js or Vite. This preserves the current deployment contract while
giving future work a stable place to add feature modules. New domain code
should prefer pure helpers in `public/modules/` or server modules with an
explicit input/output boundary before adding more state to the controllers.

## Runtime rules

- Keep API and relay requests out of the service-worker cache.
- Keep secrets in the server process or local Pi configuration; never expose
  them through public client modules.
- Keep generated build output out of the project volume. A future React build
  may use a local temporary output directory, but it must not become a runtime
  requirement for the self-hosted server.
- Preserve the public API paths so older paired devices can be upgraded
  independently. Browser cookies remain the compatibility path for manually
  added and already-saved machines; newly paired machines use a dedicated
  bearer credential instead.
- `PIHARBOR3` is a five-minute, one-use, out-of-band pairing capability. The
  joining host reviews its decoded candidate locally before making a network
  request. The target stores only the incoming credential hash, while the
  joining host stores its outgoing credential in `~/.config/pi-harbor/device-trust.json`.
  Grants are listed and revoked from Device settings, and revocation is
  enforced on the next request without a remote delete call.
- `PIHARBOR2` remains accepted when a v2.2 host joins a v2.1.2 offer through
  the legacy HMAC path; it receives no dedicated credential. An older client
  cannot silently downgrade a `PIHARBOR3` offer and must update.
- The updater performs archive-name/type preflight before extraction. Release
  signing is intentionally documented future work; the current release check
  remains checksum-based. Mermaid is still loaded from its runtime CDN, a
  known offline/privacy follow-up.

## Migration path

The next low-risk extractions are session rendering, provider management, and
device management. A React/Vite client can be introduced later if those areas
need component-level isolation; a full Next.js migration should wait until
Pi Harbor becomes a multi-user hosted service.
