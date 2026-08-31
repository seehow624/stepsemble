const CACHE_NAME = "pi-harbor-shell-v2.2.8";
const SHELL = [
  "/",
  "/index.html",
  "/style.css?v=2.2.8",
  "/i18n.js?v=2.2.8",
  "/modules/app-foundation.js?v=2.2.8",
  "/modules/session-utils.js?v=2.2.8",
  "/modules/context-usage.js?v=2.2.8",
  "/app.js?v=2.2.8",
  "/manifest.webmanifest?v=2.2.8",
  "/pi-logo.svg?v=2.2.8",
  "/pi-glyph.svg",
  "/icon-180.png?v=2.2.8",
  "/icon-512.png?v=2.2.8",
  "/vendor/marked.min.js",
  "/vendor/purify.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
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

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/r/")) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/index.html")));
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
