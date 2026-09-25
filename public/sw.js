const CACHE_NAME = "stepsemble-shell-v3.6.0";
const SHELL = [
  "/",
  "/index.html",
  "/workspace.html",
  "/modules/workspace.js?v=3.6.0",
  "/modules/workspace-i18n.js?v=3.6.0",
  "/modules/workspace-layout.js?v=3.6.0",
  "/modules/workspace.css?v=3.6.0",
  "/modules/workspace-embedded.css?v=3.6.0",
  "/style.css?v=3.6.0",
  "/i18n.js?v=3.6.0",
  "/modules/app-foundation.js?v=3.6.0",
  "/modules/agent-identity.js?v=3.6.0",
  "/modules/agent-identity.css?v=3.6.0",
  "/modules/conversation-catalog.css?v=3.6.0",
  "/modules/conversation-catalog.js?v=3.6.0",
  "/agent-logos/v1/pi.svg",
  "/agent-logos/v1/claude.svg",
  "/agent-logos/v1/codex.svg",
  "/agent-logos/v1/opencode.svg",
  "/agent-logos/v1/grok.svg",
  "/agent-logos/v1/antigravity.svg",
  "/agent-logos/v1/cline.svg",
  "/agent-logos/v1/kilo.svg",
  "/agent-logos/v1/hermes.svg",
  "/agent-logos/v1/openai.svg",
  "/agent-logos/v1/minimax.png",
  "/agent-logos/v1/agent.svg",
  "/modules/session-utils.js?v=3.6.0",
  "/modules/pi-session.js?v=3.6.0",
  "/modules/context-usage.js?v=3.6.0",
  "/modules/opencode-context.js?v=3.6.0",
  "/modules/agent-terminal.js?v=3.6.0",
  "/modules/claude-structured-rendering.js?v=3.6.0",
  "/modules/agent-transcript-presentation.js?v=3.6.0",
  "/modules/codex-approvals.js?v=3.6.0",
  "/modules/protocol-contracts.js?v=3.6.0",
  "/modules/client-sdk.js?v=3.6.0",
  "/modules/native-dialogs.js?v=3.6.0",
  "/modules/composer-ime.js?v=3.6.0",
  "/app.js?v=3.6.0",
  "/manifest.webmanifest?v=3.6.0",
  "/stepsemble-glyph.png",
  "/icon-512.png",
  "/icon-16.png?v=3.6.0",
  "/icon-32.png?v=3.6.0",
  "/icon-180.png?v=3.6.0",
  "/icon-512.png?v=3.6.0",
  "/icon-maskable-512.png?v=3.6.0",
  "/vendor/marked.min.js",
  "/vendor/purify.min.js",
  "/vendor/mermaid.min.js",
];

async function cacheShell(cache) {
  // `cache.addAll()` may reuse an HTTP-cached response for an unversioned
  // navigation entry. Fetch each shell URL with reload semantics so a newly
  // activated worker can never seed itself with the previous app shell.
  await Promise.all(SHELL.map(async (url) => {
    const request = new Request(url, { cache: "reload" });
    const response = await fetch(request);
    if (!response.ok) throw new Error(`Stepsemble shell request failed: ${url}`);
    await cache.put(url, response);
  }));
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(cacheShell).then(() => self.skipWaiting()));
});

// "/" is the Workspace; index.html is only a pane, the Settings window or the
// sign-in page. When the host cannot be reached (a computer waking up, Wi-Fi
// or VPN reconnecting, Stepsemble restarting after an update), those three get
// the cached index.html and everything else the cached Workspace.
async function offlinePage(url) {
  const ownPage = url.pathname === "/index.html" && ["pane", "settings", "returnWorkspace"].some(key => url.searchParams.get(key) === "1");
  const page = ownPage ? "/index.html" : "/workspace.html";
  return (await caches.match(page)) || Response.error();
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME && /^(?:stepsemble|pi-harbor|pi-web)-shell-v/.test(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: "window", includeUncontrolled: false }))
      // Use the former wire name for this one-way notification throughout v3:
      // both controllers understand it, including an already-open v2 page.
      .then((clients) => clients.forEach((client) => client.postMessage({ type: "PI_HARBOR_UPDATED", product: "stepsemble", version: CACHE_NAME }))),
  );
});

// Run-finished push (sent by the host only when no browser is attached to the
// session). Clicking the notification focuses an open client; the app scrolls
// to the session from the message payload.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = typeof data.title === "string" && data.title ? data.title : "Stepsemble";
  const body = typeof data.body === "string" ? data.body : "";
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "/icon-180.png",
    badge: "/stepsemble-glyph.png",
    tag: "stepsemble-run",
    data: { file: data.file || null, taskId: data.taskId || null },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const file = event.notification.data?.file || null;
  const taskId = event.notification.data?.taskId || null;
  event.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const topLevel = windowClients.filter(client => client.frameType !== "nested");
    for (const client of topLevel) {
      if (taskId) client.postMessage({ type: "PI_HARBOR_OPEN_AGENT_TASK", product: "stepsemble", taskId });
      else if (file) client.postMessage({ type: "PI_HARBOR_OPEN_SESSION", product: "stepsemble", file });
      return client.focus();
    }
    return self.clients.openWindow("/");
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/r/")) return;
  // History is a separate opt-in document, not a cached transcript or the SPA
  // navigation fallback. Offline must not show an unrelated workspace page.
  if (url.pathname === "/history.html") return;

  if (request.mode === "navigate") {
    // Reload the document on every navigation/reload. This is the important
    // path for users who left an old PWA tab open while a release went out.
    event.respondWith(fetch(new Request(request, { cache: "reload" })).catch(() => offlinePage(url)));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
      }
      return response;
    })),
  );
});
