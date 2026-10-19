const CACHE_NAME = "stepsemble-shell-v3.9.29";
const SHELL = [
  "/",
  "/index.html",
  "/workspace.html",
  "/modules/workspace.js?v=3.9.29",
  "/modules/workspace-i18n.js?v=3.9.29",
  "/modules/workspace-layout.js?v=3.9.29",
  "/modules/notifications.js?v=3.9.29",
  "/modules/workspace-order.js?v=3.9.29",
  "/modules/workspace-reorder.js?v=3.9.29",
  "/modules/assistant-i18n.js?v=3.9.29",
  "/modules/assistant-avatars.js?v=3.9.29",
  "/modules/assistant-api.js?v=3.9.29",
  "/modules/assistant-model.js?v=3.9.29",
  "/modules/assistant-navigation.js?v=3.9.29",
  "/modules/assistant-media.js?v=3.9.29",
  "/modules/workspace-assistant-model.js?v=3.9.29",
  "/modules/workspace-assistant.js?v=3.9.29",
  "/modules/workspace-automations.js?v=3.9.29",
  "/modules/usage-data.js?v=3.9.29",
  "/modules/usage-ui.js?v=3.9.29",
  "/modules/usage.css?v=3.9.29",
  "/modules/workspace.css?v=3.9.29",
  "/modules/goal-composer.js?v=3.9.29",
  "/modules/workflows-i18n.js?v=3.9.29",
  "/modules/session-reference-i18n.js?v=3.9.29",
  "/modules/session-reference.js?v=3.9.29",
  "/modules/subagent-i18n.js?v=3.9.29",
  "/modules/subagents.js?v=3.9.29",
  "/modules/subagent-panel.js?v=3.9.29",
  "/modules/session-summary.js?v=3.9.29",
  "/modules/compaction-i18n.js?v=3.9.29",
  "/modules/agent-compaction.js?v=3.9.29",
  "/modules/workflows-ui.js?v=3.9.29",
  "/modules/workflow-text.js?v=3.9.29",
  "/modules/workflows.css?v=3.9.29",
  "/modules/workspace-embedded.css?v=3.9.29",
  "/style.css?v=3.9.29",
  "/i18n.js?v=3.9.29",
  "/modules/app-foundation.js?v=3.9.29",
  "/modules/agent-identity.js?v=3.9.29",
  "/modules/agent-identity.css?v=3.9.29",
  "/modules/conversation-catalog.css?v=3.9.29",
  "/modules/conversation-catalog.js?v=3.9.29",
  "/agent-logos/v1/pi.svg",
  "/agent-logos/v1/claude.svg",
  "/agent-logos/v1/codex.svg",
  "/agent-logos/v1/opencode.svg",
  "/agent-logos/v1/grok.svg",
  "/agent-logos/v1/antigravity.svg",
  "/agent-logos/v1/cline.svg",
  "/agent-logos/v1/kilo.svg",
  "/agent-logos/v1/hermes.svg",
  "/agent-logos/v1/omp.svg",
  "/agent-logos/v1/openai.svg",
  "/agent-logos/v1/minimax.png",
  "/agent-logos/v1/agent.svg",
  "/modules/session-utils.js?v=3.9.29",
  "/modules/project-file-view.js?v=3.9.29",
  "/modules/project-browser.js?v=3.9.29",
  "/modules/pi-session.js?v=3.9.29",
  "/modules/context-usage.js?v=3.9.29",
  "/modules/output-rate.js?v=3.9.29",
  "/modules/opencode-context.js?v=3.9.29",
  "/modules/model-presentation.js?v=3.9.29",
  "/modules/agent-terminal.js?v=3.9.29",
  "/modules/claude-structured-rendering.js?v=3.9.29",
  "/modules/agent-transcript-presentation.js?v=3.9.29",
  "/modules/codex-approvals.js?v=3.9.29",
  "/modules/protocol-contracts.js?v=3.9.29",
  "/modules/client-sdk.js?v=3.9.29",
  "/modules/native-dialogs.js?v=3.9.29",
  "/modules/composer-ime.js?v=3.9.29",
  "/app.js?v=3.9.29",
  "/manifest.webmanifest?v=3.9.29",
  "/stepsemble-glyph.png",
  "/icon-512.png",
  "/icon-16.png?v=3.9.29",
  "/icon-32.png?v=3.9.29",
  "/icon-180.png?v=3.9.29",
  "/icon-512.png?v=3.9.29",
  "/icon-maskable-512.png?v=3.9.29",
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
  const cached = await caches.match(page);
  if (!cached) return Response.error();
  // A pane and Settings are shown in a frame of the Workspace. The cached
  // index.html was fetched on its own, whose headers forbid any frame, so
  // they get the headers the Host gives them: framed by this origin only.
  const framed = ownPage && ["pane", "settings"].some(key => url.searchParams.get(key) === "1");
  if (!framed) return cached;
  const headers = new Headers(cached.headers);
  headers.set("X-Frame-Options", "SAMEORIGIN");
  const policy = headers.get("Content-Security-Policy");
  if (policy) headers.set("Content-Security-Policy", policy.replace(/frame-ancestors [^;]*/, "frame-ancestors 'self'"));
  return new Response(await cached.blob(), { status: cached.status, statusText: cached.statusText, headers });
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

// Ask the foreground Workspace which sessions are actually visible. A
// service worker can be restarted between pushes, so a stale cache is not enough.
const notificationPresence = new Map(), presenceRequests = new Map();
self.addEventListener("message", event => {
  if (event.data?.type !== "STEPSEMBLE_NOTIFICATION_PRESENCE" || !event.source?.id) return;
  const data = event.data;
  const sessions = (Array.isArray(data.sessions) ? data.sessions : []).slice(0, 8).filter(row => typeof row.host === "string" && typeof row.key === "string");
  notificationPresence.set(event.source.id, { visible: data.visible === true, sessions });
  presenceRequests.get(data.requestId)?.();
});
async function viewingNotice(notice) {
  if (!notice || notice.kind === "test") return false;
  const clients = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter(client => client.frameType !== "nested" && client.visibilityState === "visible");
  await Promise.all(clients.map(client => new Promise(resolve => {
    const requestId = "presence-" + client.id + "-" + Math.random();
    const done = () => { clearTimeout(timer); presenceRequests.delete(requestId); resolve(); };
    const timer = setTimeout(done, 250); presenceRequests.set(requestId, done);
    notificationPresence.delete(client.id);
    client.postMessage({ type: "STEPSEMBLE_NOTIFICATION_PRESENCE_REQUEST", requestId });
  })));
  // Prune closed clients; only freshly acknowledged visible sessions qualify.
  for (const id of notificationPresence.keys()) if (!clients.some(client => client.id === id)) notificationPresence.delete(id);
  return clients.some(client => {
    const state = notificationPresence.get(client.id);
    return state?.visible && state.sessions.some(row => row.host === notice.host && row.key === notice.key);
  });
}
self.addEventListener("push", event => {
  let data = {}; try { data = event.data ? event.data.json() : {}; } catch {}
  event.waitUntil((async () => {
    const notice = data.notice;
    const title = typeof data.title === "string" && data.title ? data.title : "Stepsemble";
    const body = typeof data.body === "string" ? data.body : "";
    // Safari takes a push subscription back when its pushes show nothing, so
    // a notice for the conversation on screen is shown and closed at once.
    if (await viewingNotice(notice)) {
      const tag = "stepsemble:on-screen";
      await self.registration.showNotification(title, { body, tag, silent: true, icon: "/icon-180.png", badge: "/stepsemble-glyph.png" });
      for (const shown of await self.registration.getNotifications({ tag })) shown.close();
      return;
    }
    const identity = notice?.host && notice?.key ? notice.host + ":" + notice.key : data.taskId || data.file || data.ts || "run";
    // A newer alert replaces the conversation's older one and still alerts;
    // one that waits for the person stays until they answer it.
    const waiting = notice?.kind === "approval" || notice?.kind === "blockedGoal";
    await self.registration.showNotification(title, {
      body,
      icon: "/icon-180.png", badge: "/stepsemble-glyph.png", tag: "stepsemble:" + identity, renotify: true, requireInteraction: waiting,
      ...(Number.isFinite(notice?.at) ? { timestamp: notice.at } : {}),
      data: { notice: notice || null, file: data.file || null, taskId: data.taskId || null },
    });
  })());
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const { notice, file, taskId, url } = event.notification.data || {};
  // An assistant notice opens that Bot's conversation on the assistant page.
  const assistant = typeof url === "string" && url.startsWith("/assistant.html?") ? url : null;
  const valid = notice && /^[a-zA-Z0-9_-]{1,128}$/.test(notice.host) && /^[a-f0-9-]{36}$/i.test(notice.key);
  const href = assistant || (valid ? "/workspace.html?host=" + encodeURIComponent(notice.host) + "&entry=" + encodeURIComponent(notice.key) : "/workspace.html");
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients.filter(row => row.frameType !== "nested")) {
      const current = new URL(client.url);
      if (current.origin !== self.location.origin) continue;
      if (assistant) {
        if (current.pathname !== "/assistant.html") continue;
        client.postMessage({ type: "STEPSEMBLE_OPEN_ASSISTANT", url: assistant });
        return client.focus();
      }
      if (!["/", "/workspace.html"].includes(current.pathname)) continue;
      if (valid) client.postMessage({ type: "STEPSEMBLE_OPEN_NOTIFICATION", notice });
      else if (taskId) client.postMessage({ type: "PI_HARBOR_OPEN_AGENT_TASK", product: "stepsemble", taskId });
      else if (file) client.postMessage({ type: "PI_HARBOR_OPEN_SESSION", product: "stepsemble", file });
      return client.focus();
    }
    return self.clients.openWindow(href);
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
