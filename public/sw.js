const CACHE_NAME = "pi-harbor-shell-v2.13.1";
const SHELL = [
  "/",
  "/index.html",
  "/style.css?v=2.13.1",
  "/i18n.js?v=2.13.1",
  "/modules/app-foundation.js?v=2.13.1",
  "/modules/session-utils.js?v=2.13.1",
  "/modules/context-usage.js?v=2.13.1",
  "/app.js?v=2.13.1",
  "/manifest.webmanifest?v=2.13.1",
  "/pi-logo.svg?v=2.13.1",
  "/pi-glyph.svg",
  "/icon-180.png?v=2.13.1",
  "/icon-512.png?v=2.13.1",
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
    if (!response.ok) throw new Error(`Pi Harbor shell request failed: ${url}`);
    await cache.put(url, response);
  }));
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(cacheShell).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: "window", includeUncontrolled: false }))
      .then((clients) => clients.forEach((client) => client.postMessage({ type: "PI_HARBOR_UPDATED", version: CACHE_NAME }))),
  );
});

// Run-finished push (sent by the host only when no browser is attached to the
// session). Clicking the notification focuses an open client; the app scrolls
// to the session from the message payload.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = typeof data.title === "string" && data.title ? data.title : "Pi Harbor";
  const body = typeof data.body === "string" ? data.body : "";
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "/icon-180.png",
    badge: "/pi-glyph.svg",
    tag: "pi-harbor-run",
    data: { file: data.file || null, taskId: data.taskId || null },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const file = event.notification.data?.file || null;
  const taskId = event.notification.data?.taskId || null;
  event.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windowClients) {
      if (taskId) client.postMessage({ type: "PI_HARBOR_OPEN_AGENT_TASK", taskId });
      else if (file) client.postMessage({ type: "PI_HARBOR_OPEN_SESSION", file });
      return client.focus();
    }
    return self.clients.openWindow("/");
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/r/")) return;

  if (request.mode === "navigate") {
    // Reload the document on every navigation/reload. This is the important
    // path for users who left an old PWA tab open while a release went out.
    event.respondWith(fetch(new Request(request, { cache: "reload" })).catch(() => caches.match("/index.html")));
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
