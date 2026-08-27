# Pi Web architecture

Pi Web intentionally remains a dependency-free Node/PWA application. The
runtime is local to each Pi Agent computer, so the app must continue to work
without a build server and must keep launchd, Tailscale, SSE, and the updater
simple.

## Boundaries

```text
server.js
  ├─ Pi/session/provider/device behavior and route table
  └─ server/http-utils.js  HTTP headers, cookies, JSON bodies, SSE framing

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
  independently.

## Migration path

The next low-risk extractions are session rendering, provider management, and
device management. A React/Vite client can be introduced later if those areas
need component-level isolation; a full Next.js migration should wait until
Pi Web becomes a multi-user hosted service.
