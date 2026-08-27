const CACHE_NAME = "pi-web-shell-v1.11.20";
const SHELL = [
  "/",
  "/index.html",
  "/style.css?v=1.11.20",
  "/i18n.js?v=1.11.20",
  "/app.js?v=1.11.20",
  "/manifest.webmanifest?v=1.11.20",
  "/pi-logo.svg?v=1.11.20",
  "/icon-180.png?v=1.11.20",
  "/icon-512.png?v=1.11.20",
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
      .then((clients) => clients.forEach((client) => client.postMessage({ type: "PI_WEB_UPDATED", version: CACHE_NAME }))),
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
