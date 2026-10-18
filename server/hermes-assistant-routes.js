"use strict";

// HTTP routes for the assistant page. server.js has already checked the
// caller's Stepsemble sign-in before any of these run. Only GET and POST are
// used, so the device relay (/r/<machine>/api/...) can carry every call, and
// the event stream ends in /stream so the relay keeps it open.

const { Readable, Transform, pipeline } = require("node:stream");
const Media = require("../public/modules/assistant-media");
const { MAX_TEXT, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } = require("./hermes-assistant-service");

const SANDBOX = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const escapeText = value => value.replace(/[&<>]/g, char => ESCAPES[char]);

// A text file opens as a page laid out for the device width, with its content
// escaped into one <pre>. latin1 maps each byte to one character, so UTF-8
// passes through untouched and only the ASCII & < > change.
function textPage(name) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeText(name)}</title>`
    + "<style>:root{color-scheme:light dark;-webkit-text-size-adjust:100%}body{margin:0}pre{margin:0;padding:16px 16px 32px;white-space:pre-wrap;overflow-wrap:anywhere;font:15px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;tab-size:4}</style>"
    + "</head><body><pre>\n";
}
function escapedText() {
  return new Transform({
    transform(chunk, _encoding, done) { done(null, Buffer.from(escapeText(chunk.toString("latin1")), "latin1")); },
    flush(done) { done(null, "</pre></body></html>\n"); },
  });
}
const SMALL = 64 * 1024, LOGIN = 8 * 1024, AVATAR = 4 * 1024 * 1024, SKILL = 1024 * 1024;
// A message holds as many attachments as the service accepts, each in base64,
// plus its text even if every character is escaped.
const PROMPT = MAX_ATTACHMENTS * Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 6 * MAX_TEXT + 64 * 1024;

function createHermesAssistantRoutes({ service, routines, groups, bots, skills, console: hermesConsole, readJSON, sendJSON, sseFrame, trySseWrite }) {
  function fail(res, error) {
    const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 502;
    sendJSON(res, status, { error: typeof error?.code === "string" ? error.code : "assistant_failed",
      message: typeof error?.message === "string" ? error.message.slice(0, 300) : "" });
  }

  function stream(req, res, url) {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive",
      "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    const after = Math.max(Number(url.searchParams.get("after")) || 0, Number(req.headers["last-event-id"]) || 0);
    let closed = false, ping = null, unsubscribe = () => {};
    const end = () => {
      if (closed) return;
      closed = true;
      if (ping) clearInterval(ping);
      unsubscribe();
      try { res.end(); } catch {}
    };
    unsubscribe = service.subscribe(event => { if (!closed && !trySseWrite(res, sseFrame(event, null, event.id))) end(); }, after);
    if (closed) { unsubscribe(); return; }
    ping = setInterval(() => { if (!trySseWrite(res, ": ping\n\n")) end(); }, 15_000);
    req.on("close", end);
    res.on("close", end);
    res.on("error", end);
  }

  // Attachments: files a Bot sent stream from Hermes. Only types that are safe
  // to open on this origin are shown inline; everything else downloads.
  async function media(req, res, url) {
    const path = url.searchParams.get("path") || "";
    const meta = Media.describe(path), type = Media.contentType(path);
    const download = url.searchParams.get("download") === "1" || !type;
    const page = meta.kind === "text" && !download;
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    let upstream;
    try { upstream = await service.mediaFile(path, { range: page ? undefined : req.headers.range, signal: controller.signal }); } catch (error) {
      const code = { 403: "assistant_media_forbidden", 404: error?.code === "assistant_media_not_found" ? error.code : "assistant_media_missing",
        413: "assistant_media_too_large", 416: "assistant_media_range" }[error?.statusCode];
      if (code) error.code = code;
      throw error;
    }
    const name = meta.name.replace(/[\r\n"\\]/g, "_");
    const headers = {
      "content-type": page ? "text/html; charset=utf-8" : type || "application/octet-stream",
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "x-content-type-options": "nosniff", "cache-control": "private, max-age=300", "referrer-policy": "no-referrer",
    };
    // PDFs go to the browser's own viewer; anything else shown inline is
    // sandboxed and cannot run script.
    if (meta.kind !== "pdf" || download) headers["content-security-policy"] = SANDBOX;
    for (const key of page ? ["last-modified"] : ["content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
      const value = upstream.headers.get(key);
      if (value) headers[key] = value;
    }
    res.writeHead(upstream.status === 206 ? 206 : 200, headers);
    if (req.method === "HEAD" || !upstream.body) { controller.abort(); res.end(); return; }
    if (page) {
      res.write(textPage(meta.name));
      pipeline(Readable.fromWeb(upstream.body), escapedText(), res, () => {});
      return;
    }
    pipeline(Readable.fromWeb(upstream.body), res, () => {});
  }

  // Bot settings and skills: reads are GET with the profile in the query,
  // changes are POST with a JSON body.
  async function manage(req, res, url, p, get, post) {
    const q = key => url.searchParams.get(key);
    if (get) {
      const reads = {
        "/api/assistant/bot/describe": () => bots.describe(q("profile")),
        "/api/assistant/bot/models": () => bots.models(q("profile")),
        "/api/assistant/bot/avatar": () => bots.avatar(q("profile")),
        "/api/assistant/skills": () => skills.list(q("profile")),
        "/api/assistant/skills/content": () => skills.content(q("profile"), q("name")),
        "/api/assistant/skills/hub/search": () => skills.search(q("profile"), q("q")),
        "/api/assistant/skills/hub/preview": () => skills.preview(q("profile"), q("identifier")),
        "/api/assistant/skills/hub/scan": () => skills.scan(q("profile"), q("identifier")),
        "/api/assistant/skills/action": () => skills.action(q("name")),
      };
      if (reads[p]) { sendJSON(res, 200, await reads[p]()); return; }
    } else if (post) {
      const limit = p === "/api/assistant/bot/avatar" ? AVATAR : p === "/api/assistant/skills/save" ? SKILL : SMALL;
      const writes = {
        "/api/assistant/bot/create": body => bots.create(body.fields || {}),
        "/api/assistant/bot/configure": body => bots.configure(body.profile, body.changes || {}),
        "/api/assistant/bot/avatar": body => bots.setAvatar(body.profile, body.data ?? null),
        "/api/assistant/bot/delete": body => bots.remove(body.profile, body.confirm),
        "/api/assistant/skills/toggle": body => skills.toggle(body.profile, body.name, body.enabled),
        "/api/assistant/skills/save": body => skills.save(body.profile, body.name, body.content),
        "/api/assistant/skills/install": body => skills.install(body.profile, body.identifier, { acknowledged: body.acknowledged === true }),
        "/api/assistant/skills/uninstall": body => skills.uninstall(body.profile, body.name),
      };
      if (writes[p]) { sendJSON(res, 200, await writes[p](await readJSON(req, limit))); return; }
    }
    sendJSON(res, 404, { error: "assistant_route_not_found" });
  }

  // The Hermes console (Settings → Agents & models → Hermes).
  async function consoleRoute(req, res, url, p, get, post) {
    if (get && p === "/api/assistant/console") { sendJSON(res, 200, await hermesConsole.overview()); return; }
    if (get && p === "/api/assistant/console/usage") { sendJSON(res, 200, await hermesConsole.usage(url.searchParams.get("days"))); return; }
    if (get && p === "/api/assistant/console/restart-status") { sendJSON(res, 200, await hermesConsole.restartStatus()); return; }
    const writes = {
      "/api/assistant/console/main": body => hermesConsole.setMain(body),
      "/api/assistant/console/auxiliary": body => hermesConsole.setAuxiliary(body),
      "/api/assistant/console/reasoning": body => hermesConsole.setReasoning(body.level),
      "/api/assistant/console/fallback": body => hermesConsole.setFallback(body.chain),
      "/api/assistant/console/key": body => hermesConsole.setKey(body.key, body.value),
      "/api/assistant/console/key/remove": body => hermesConsole.removeKey(body.key),
      "/api/assistant/console/endpoint": body => hermesConsole.saveEndpoint(body.fields || {}),
      "/api/assistant/console/endpoint/activate": body => hermesConsole.activateEndpoint(body.id),
      "/api/assistant/console/endpoint/remove": body => hermesConsole.removeEndpoint(body.id),
      "/api/assistant/console/restart": () => hermesConsole.restartGateway(),
    };
    if (post && writes[p]) { sendJSON(res, 200, await writes[p](await readJSON(req, SMALL))); return; }
    sendJSON(res, 404, { error: "assistant_route_not_found" });
  }

  return async function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith("/api/assistant/")) return false;
    const get = req.method === "GET", post = req.method === "POST";
    try {
      if (p === "/api/assistant/status" && get) sendJSON(res, 200, await service.status());
      else if (p === "/api/assistant/media" && (get || req.method === "HEAD")) await media(req, res, url);
      else if (p === "/api/assistant/stream" && get) stream(req, res, url);
      else if (p === "/api/assistant/login" && post) {
        const body = await readJSON(req, LOGIN);
        sendJSON(res, 200, await service.login(body.username, body.password));
      } else if (p === "/api/assistant/logout" && post) sendJSON(res, 200, await service.logout());
      else if (p === "/api/assistant/bots" && get) sendJSON(res, 200, await service.bots());
      else if (p === "/api/assistant/bot-chat" && post) sendJSON(res, 200, await service.openBotChat((await readJSON(req, SMALL)).profile));
      else if (p === "/api/assistant/session/open" && post) sendJSON(res, 200, await service.openSession(await readJSON(req, SMALL)));
      else if (p === "/api/assistant/sessions" && get) {
        sendJSON(res, 200, await service.listSessions({ profile: url.searchParams.get("profile"), query: url.searchParams.get("q") || "",
          offset: url.searchParams.get("offset") || 0 }));
      } else if (p === "/api/assistant/session/rename" && post) sendJSON(res, 200, await service.renameSession(await readJSON(req, SMALL)));
      else if (p === "/api/assistant/session/read" && post) sendJSON(res, 200, await service.markRead(await readJSON(req, SMALL)));
      else if (p === "/api/assistant/session/delete" && post) sendJSON(res, 200, await service.deleteSession(await readJSON(req, SMALL)));
      else if (p === "/api/assistant/prompt" && post) sendJSON(res, 202, await service.prompt(await readJSON(req, PROMPT)));
      else if (p === "/api/assistant/interrupt" && post) sendJSON(res, 200, await service.interrupt(await readJSON(req, SMALL)));
      else if (p === "/api/assistant/asks" && get) sendJSON(res, 200, { asks: service.pendingAsks() });
      else if (p === "/api/assistant/respond" && post) sendJSON(res, 200, await service.respond(await readJSON(req, SMALL)));
      else if (p === "/api/assistant/routines" && get) sendJSON(res, 200, await routines.list(url.searchParams.get("profile") || null));
      else if (p === "/api/assistant/routines/targets" && get) sendJSON(res, 200, await routines.targets(url.searchParams.get("profile")));
      else if (p === "/api/assistant/routines/runs" && get) sendJSON(res, 200, await routines.runs(url.searchParams.get("id"), url.searchParams.get("profile")));
      else if (p === "/api/assistant/routines/create" && post) {
        const body = await readJSON(req, SMALL);
        sendJSON(res, 200, await routines.create(body.profile, body.fields || {}));
      } else if (p === "/api/assistant/routines/update" && post) {
        const body = await readJSON(req, SMALL);
        sendJSON(res, 200, await routines.update(body.id, body.profile, body.fields || {}));
      } else if (/^\/api\/assistant\/routines\/(pause|resume|run|delete)$/.test(p) && post) {
        const body = await readJSON(req, SMALL);
        const verb = p.slice("/api/assistant/routines/".length);
        sendJSON(res, 200, await routines[verb === "delete" ? "remove" : verb](body.id, body.profile));
      } else if (p === "/api/assistant/groups" && get) {
        const capabilities = await groups.capabilities();
        sendJSON(res, 200, { ...capabilities, rooms: capabilities.supported ? (await groups.list()).rooms : [] });
      } else if (p === "/api/assistant/groups/create" && post) sendJSON(res, 200, await groups.create(await readJSON(req, SMALL)));
      else if (p === "/api/assistant/groups/log" && get) {
        const log = await groups.log(url.searchParams.get("room"), url.searchParams.get("since") || "0");
        for (const item of log.events) if (item.kind === "message.member") service.offerMedia(item.text);
        sendJSON(res, 200, log);
      }
      else if (p === "/api/assistant/groups/state" && get) sendJSON(res, 200, await groups.state(url.searchParams.get("room")));
      else if (/^\/api\/assistant\/groups\/(send|approve|retry|rename|stop|disband)$/.test(p) && post) {
        const body = await readJSON(req, SMALL);
        const verb = p.slice("/api/assistant/groups/".length);
        const extra = { send: body.text, retry: body.taskId, rename: body.name,
          approve: { memberId: body.memberId, taskId: body.taskId, executionGeneration: body.executionGeneration, requestId: body.requestId, choice: body.choice } }[verb];
        sendJSON(res, 200, extra === undefined ? await groups[verb](body.room) : await groups[verb](body.room, extra));
      } else if (p === "/api/assistant/console" || p.startsWith("/api/assistant/console/")) {
        await consoleRoute(req, res, url, p, get, post);
      } else if (p.startsWith("/api/assistant/bot/") || p === "/api/assistant/skills" || p.startsWith("/api/assistant/skills/")) {
        await manage(req, res, url, p, get, post);
      } else if (p === "/api/assistant/watch" && post) {
        const body = await readJSON(req, SMALL);
        sendJSON(res, 200, service.watch(body.clientId, body.sessionId ?? null));
      } else sendJSON(res, 404, { error: "assistant_route_not_found" });
    } catch (error) {
      if (!res.headersSent) fail(res, error);
    }
    return true;
  };
}

module.exports = { createHermesAssistantRoutes, PROMPT };
