"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const http = require("node:http"), net = require("node:net"), { once } = require("node:events");
const path = require("node:path");
const { createHistoryHttpHandler, LIMITS, VIEW_HEADER, CSRF_HEADER } = require("../server/history-http");
const VIEW = "11111111-1111-4111-8111-111111111111", BINDING = "22222222-2222-4222-8222-222222222222";
const REQUEST = "33333333-3333-4333-8333-333333333333", SESSION = "44444444-4444-4444-8444-444444444444";
const ORIGIN = "https://history.example:9443", PEER = "a".repeat(64);
const PAGE = { bindingId: BINDING, generation: 1, requestId: REQUEST, page: { offset: 0, limit: 25 } };
const REG = { catalogId: "synthetic", viewId: VIEW };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function reply(body = PAGE) {
  return { kind: "bound_history_observation", bindingId: body.bindingId, generation: body.generation, requestId: body.requestId,
    sourceVersion: "b".repeat(64), history: { kind: "source_history_observation", source: { sourceAuthenticated: false, publishable: false },
      page: { ...body.page }, observation: { publishable: false, authority: { sourceAuthenticated: false, approvalAcknowledged: false,
        runTerminalObserved: false, resumeAllowed: false } }, reader: {}, metrics: {} }, sourceAuthenticated: false, publishable: false, cleanupConfirmed: true };
}
async function fixture(t, { observe, deadlineMs = 500, current, listCatalog, register, cancelRegistration } = {}) {
  const calls = [], completed = [], state = { active: true, peer: true, current: true, aborts: 0, browserChecks: 0, peerChecks: 0 };
  const auth = {
    authenticateBrowserCookie(name, value) { state.browserChecks++; return name === "stepsemble" && value === "synthetic-cookie" && state.active ? "browser:synthetic" : null; },
    authenticatePeerCredential(value) { state.peerChecks++; return state.peer && value === PEER ? "peer:synthetic" : null; },
    isPrincipalCurrent() { return state.active; },
  };
  const registry = {
    register(principal, body, options) { calls.push({ action: "register", principal, body }); return register ? register(principal, body, options, state)
      : { kind: "history_registration", ...body, bindingId: BINDING, generation: 1, sessionId: SESSION, expiresAt: Date.now() + 60000, sourceAuthenticated: false, publishable: false }; },
    observe(principal, body, options) { calls.push({ action: "observe", principal, body }); return observe ? observe(principal, body, options, state) : reply(body); },
    release(principal, body) { calls.push({ action: "release", principal, body }); return { kind: "history_released", cleanupConfirmed: false }; },
    current(principal, scope) { return current ? current(principal, scope, state) : state.current; },
    ...(cancelRegistration ? { cancelRegistration } : {}),
  };
  const handler = createHistoryHttpHandler({ registry, auth, allowedOrigins: [ORIGIN], deadlineMs, listCatalog });
  const server = http.createServer(async (req, res) => {
    const before = [req.listenerCount("aborted"), res.listenerCount("close"), res.listenerCount("error")];
    const handled = await handler(req, res);
    completed.push({ before, after: [req.listenerCount("aborted"), res.listenerCount("close"), res.listenerCount("error")], req, res });
    if (!handled) res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  const headers = { cookie: "stepsemble=synthetic-cookie", origin: ORIGIN, "content-type": "application/json", [VIEW_HEADER]: VIEW, [CSRF_HEADER]: "1" };
  async function request(path = "/api/history/page", body = PAGE, overrides = {}, method = "POST") {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const hs = { ...headers, ...overrides }; for (const key of Object.keys(hs)) if (hs[key] === undefined) delete hs[key];
    if (method === "DELETE" && hs["content-length"] === undefined) hs["content-length"] = raw.length;
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path, method, headers: hs }, res => {
        const chunks = []; let size = 0;
        res.on("data", chunk => { size += chunk.length; if (size > LIMITS.responseBytes) return res.destroy(new Error("unbounded response")); chunks.push(chunk); });
        res.on("error", reject); res.on("end", () => {
          const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, bytes, data: bytes.length ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) : null });
        });
      }); req.on("error", reject); req.end(raw);
    });
  }
  return { port, request, headers, state, calls, completed, handler };
}

test("actual HTTP registration/page/release preserve inert envelope and inject header view scope", async t => {
  const f = await fixture(t);
  const registered = await f.request("/api/history/registrations", REG);
  assert.equal(registered.status, 200); assert.equal(registered.data.sourceAuthenticated, false); assert.equal(registered.data.viewId, VIEW);
  const page = await f.request(); assert.deepEqual(page.data, reply());
  assert.equal(f.calls[1].principal, "browser:synthetic"); assert.equal(f.calls[1].body.viewId, VIEW);
  assert.equal(page.headers["cache-control"], "no-store"); assert.equal(page.headers["access-control-allow-origin"], undefined);
  assert.equal(Number(page.headers["content-length"]), page.bytes.length);
  const released = await f.request(`/api/history/registrations/${BINDING}`, { generation: 1 }, {}, "DELETE");
  assert.deepEqual(released.data, { kind: "history_released", cleanupConfirmed: false });
  assert.deepEqual(f.calls[2].body, { bindingId: BINDING, generation: 1, viewId: VIEW });
  assert.ok(f.completed.every(row => JSON.stringify(row.before) === JSON.stringify(row.after)));
  assert.ok(f.completed.every(row => row.req.listenerCount("data") === 0));
});

test("native reader denials preserve fixed codes without exposing source diagnostics", async t => {
  let code, extra = {};
  const f = await fixture(t, { observe: () => ({ kind: "source_unavailable", code, ...extra }) });
  for (code of ["source_acl_unavailable", "source_acl_unsupported", "source_root_identity_changed", "source_containment_unavailable",
    "source_identity_unavailable", "source_close_failed", "/private/synthetic-source"]) {
    const result = await f.request();
    assert.equal(result.status, 409);
    assert.deepEqual(result.data, { kind: "source_unavailable", code: code.startsWith("/") ? "history_transport_failed" : code });
    assert.ok(!result.bytes.includes(Buffer.from("private")));
  }
  code = "source_acl_unavailable"; extra = { path: "/private/synthetic-source", diagnostic: "private-detail" };
  const invalid = await f.request();
  assert.equal(invalid.status, 502); assert.equal(invalid.data.code, "history_response_invalid");
  assert.ok(!invalid.bytes.includes(Buffer.from("private")));
});

test("browser boundary uses configured scheme/host/port and requires JSON/CSRF/Origin", async t => {
  const f = await fixture(t);
  for (const origin of [undefined, "null", "http://history.example:9443", "https://history.example", "https://evil.example:9443", `${ORIGIN}/`, `${ORIGIN}/path`, `${ORIGIN}, https://evil.example`]) {
    const result = await f.request(undefined, PAGE, { origin, host: "history.example:9443", "x-forwarded-host": "history.example:9443", "x-forwarded-proto": "https" });
    assert.equal(result.status, 403, String(origin));
  }
  assert.equal((await f.request(undefined, PAGE, { [CSRF_HEADER]: undefined })).status, 403);
  assert.equal((await f.request(undefined, PAGE, { "content-type": "text/plain" })).status, 415);
  assert.equal((await f.request(undefined, PAGE, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request(undefined, PAGE, { host: "untrusted-header.invalid", "content-type": "application/json; charset=utf-8" })).status, 200);
});

test("invalid bearer never falls back to cookies, all mixed credentials fail closed, peer is current", async t => {
  const f = await fixture(t);
  for (const authorization of ["", "Basic secret", `Bearer ${"f".repeat(64)}`, `Bearer ${PEER}`]) {
    assert.equal((await f.request(undefined, PAGE, { authorization })).status, 401);
  }
  assert.equal(f.state.browserChecks, 0); assert.equal(f.calls.length, 0);
  const peerHeaders = { authorization: `Bearer ${PEER}`, cookie: undefined, origin: undefined, [CSRF_HEADER]: undefined };
  assert.equal((await f.request(undefined, PAGE, peerHeaders)).status, 200);
  assert.equal(f.calls[0].principal, "peer:synthetic"); assert.equal(f.state.peerChecks, 3);
  f.state.peer = false;
  assert.equal((await f.request(undefined, PAGE, peerHeaders)).status, 401);
  assert.equal((await f.request(undefined, PAGE, { cookie: "stepsemble=synthetic-cookie; stepsemble=synthetic-cookie" })).status, 401);
});

test("strict request keys reject path/SDK/env/authority and view mismatch before registry", async t => {
  const f = await fixture(t);
  for (const key of ["source", "path", "nativePath", "projectsRoot", "projectKey", "file", "sdkPath", "executable", "env", "principal", "viewId", "timeoutMs"]) {
    const result = await f.request(undefined, { ...PAGE, [key]: "SYNTHETIC_PRIVATE" }); assert.equal(result.status, 400, key);
    assert.ok(!result.bytes.includes(Buffer.from("SYNTHETIC_PRIVATE")));
  }
  for (const body of [{ ...PAGE, page: { ...PAGE.page, env: {} } }, { ...PAGE, version: null }, { ...PAGE, generation: 0 }, { ...PAGE, page: { offset: 2001, limit: 25 } }])
    assert.equal((await f.request(undefined, body)).status, 400);
  assert.equal((await f.request("/api/history/registrations", { ...REG, viewId: REQUEST })).status, 400);
  assert.equal((await f.request(`/api/history/registrations/${BINDING}`, { generation: 1, viewId: VIEW }, {}, "DELETE")).status, 400);
  assert.equal((await f.request("/api/history/page?path=secret")).status, 405);
  assert.equal(f.calls.length, 0);
});

test("raw body limit and fatal UTF-8 parsing reject actual HTTP bytes before registry", async t => {
  const f = await fixture(t);
  const oversized = Buffer.from(JSON.stringify({ ...PAGE, secret: "x".repeat(LIMITS.requestBytes) }));
  assert.equal((await f.request(undefined, oversized)).status, 413); // chunked, no Content-Length
  assert.equal((await f.request(undefined, PAGE, { "content-length": LIMITS.requestBytes + 1 })).status, 413);
  const malformed = Buffer.concat([Buffer.from('{"bad":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
  assert.equal((await f.request(undefined, malformed)).data.code, "history_body_invalid");
  assert.equal((await f.request(undefined, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(PAGE))]))).status, 400);
  assert.equal(f.calls.length, 0);
});

test("slow chunks and a falsely large Content-Length expire within a bounded deadline", async t => {
  const f = await fixture(t, { deadlineMs: 60 });
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: f.port, path: "/api/history/page", method: "POST", headers: { ...f.headers, "content-length": "2000" } }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); req.write("{"); const timer = setInterval(() => req.write(" "), 8); req.on("close", () => clearInterval(timer));
  });
  assert.equal(result.status, 408); assert.equal(JSON.parse(result.raw).code, "history_request_timeout"); assert.equal(f.calls.length, 0);
  assert.deepEqual(f.completed[0].after, f.completed[0].before);
});

test("false short Content-Length never publishes truncated JSON", async t => {
  const f = await fixture(t);
  const socket = net.connect(f.port, "127.0.0.1"); await once(socket, "connect");
  const chunks = []; socket.on("data", value => chunks.push(value));
  socket.write(`POST /api/history/page HTTP/1.1\r\nHost: localhost\r\nOrigin: ${ORIGIN}\r\nCookie: stepsemble=synthetic-cookie\r\nContent-Type: application/json\r\n${VIEW_HEADER}: ${VIEW}\r\n${CSRF_HEADER}: 1\r\nContent-Length: 8\r\nConnection: close\r\n\r\n${JSON.stringify(PAGE)}`);
  await once(socket, "close"); assert.equal(f.calls.length, 0);
  assert.ok(!Buffer.concat(chunks).includes(Buffer.from("bound_history_observation")));
});

test("duplicate security headers fail closed before registry", async t => {
  const f = await fixture(t);
  for (const duplicate of [`Origin: ${ORIGIN}`, `Cookie: stepsemble=synthetic-cookie`, `${VIEW_HEADER}: ${VIEW}`, `${CSRF_HEADER}: 1`, "Content-Type: application/json"]) {
    const socket = net.connect(f.port, "127.0.0.1"); await once(socket, "connect");
    const chunks = []; socket.on("data", value => chunks.push(value));
    const body = JSON.stringify(PAGE);
    socket.write(`POST /api/history/page HTTP/1.1\r\nHost: localhost\r\nOrigin: ${ORIGIN}\r\nCookie: stepsemble=synthetic-cookie\r\nContent-Type: application/json\r\n${VIEW_HEADER}: ${VIEW}\r\n${CSRF_HEADER}: 1\r\n${duplicate}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    await once(socket, "close"); assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1.1 401 /);
  }
  assert.equal(f.calls.length, 0);
});

test("revocation during observe and registry generation change prevent late publish", async t => {
  for (const mode of ["browser", "peer", "generation"]) {
    const f = await fixture(t, { observe: async (_p, body, _options, state) => {
      await delay(10); if (mode === "browser") state.active = false; else if (mode === "peer") state.peer = false; else state.current = false;
      return reply(body);
    } });
    const headers = mode === "peer" ? { cookie: undefined, origin: undefined, authorization: `Bearer ${PEER}` } : {};
    const result = await f.request(undefined, PAGE, headers);
    assert.equal(result.status, mode === "generation" ? 409 : 401); assert.ok(!result.bytes.includes(Buffer.from("bound_history_observation")));
  }
});

test("disconnect aborts in-flight observe and removes request/response listeners", async t => {
  let started;
  const didStart = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { observe: (_p, body, { signal }, state) => new Promise(resolve => {
    started(); signal.addEventListener("abort", () => { state.aborts++; resolve(reply(body)); }, { once: true });
  }) });
  const req = http.request({ hostname: "127.0.0.1", port: f.port, path: "/api/history/page", method: "POST", headers: f.headers });
  req.on("error", () => {}); req.end(JSON.stringify(PAGE)); await didStart; req.destroy();
  for (let i = 0; i < 30 && !f.completed.length; i++) await delay(5);
  assert.equal(f.state.aborts, 1); assert.equal(f.completed.length, 1); assert.deepEqual(f.completed[0].before, f.completed[0].after);
});

test("aborted upload never reaches registry and its listener cleanup completes", async t => {
  const f = await fixture(t);
  const req = http.request({ hostname: "127.0.0.1", port: f.port, path: "/api/history/page", method: "POST", headers: { ...f.headers, "content-length": "200" } });
  req.on("error", () => {}); req.write("{"); await delay(15); req.destroy();
  for (let i = 0; i < 30 && !f.completed.length; i++) await delay(5);
  assert.equal(f.calls.length, 0); assert.equal(f.completed.length, 1); assert.deepEqual(f.completed[0].before, f.completed[0].after);
  assert.equal(f.completed[0].req.listenerCount("data"), 0);
});

test("deadline aborts an observer that ignores cancellation; its late result cannot publish", async t => {
  let finish, signal;
  const f = await fixture(t, { deadlineMs: 40, observe: (_p, body, options) => {
    signal = options.signal; return new Promise(resolve => { finish = () => resolve(reply(body)); });
  } });
  const result = await f.request();
  assert.equal(result.status, 408); assert.equal(signal.aborted, true); assert.equal(result.data.code, "history_request_timeout");
  assert.equal(f.completed.length, 1); assert.deepEqual(f.completed[0].before, f.completed[0].after);
  finish(); await delay(5); assert.equal(f.completed.length, 1);
});

test("outer response bytes are capped before writing and exceptions/codes are sanitized", async t => {
  for (const mode of ["oversized", "throw", "code", "authority", "nestedAuthority"]) {
    const f = await fixture(t, { observe: () => {
      if (mode === "throw") throw new Error("/private/native/SYNTHETIC_SECRET");
      if (mode === "code") return { kind: "source_unavailable", code: "/private/native/SYNTHETIC_SECRET" };
      if (mode === "authority") return { ...reply(), sourceAuthenticated: true };
      if (mode === "nestedAuthority") { const value = reply(); value.history.observation.authority.resumeAllowed = true; return value; }
      return { ...reply(), history: { transcript: "中".repeat(LIMITS.responseBytes / 2) } };
    } });
    const result = await f.request(); assert.notEqual(result.status, 200); assert.ok(result.bytes.length <= LIMITS.responseBytes);
    assert.ok(!result.bytes.includes(Buffer.from("SYNTHETIC_SECRET"))); assert.equal(result.headers["cache-control"], "no-store");
    if (mode === "oversized") assert.equal(result.data.code, "history_response_too_large");
  }
});

test("HTTP configuration fails closed and unrelated routes remain unhandled", async t => {
  assert.throws(() => createHistoryHttpHandler(), /configuration_invalid/);
  const f = await fixture(t); assert.equal((await f.request("/elsewhere")).status, 404);
});

test("catalog is optional, authenticated and bounded with exact display-only entries", async t => {
  const absent = await fixture(t);
  assert.equal((await absent.request("/api/history/catalog", {})).data.code, "history_source_unavailable");
  const entry = { catalogId: "synthetic", label: "Synthetic source", description: "Owned fixture only" };
  const f = await fixture(t, { listCatalog: principal => { assert.equal(principal, "browser:synthetic"); return [entry]; } });
  const result = await f.request("/api/history/catalog", {});
  assert.deepEqual(result.data, { kind: "history_catalog", entries: [entry], sourceAuthenticated: false, publishable: false });
  assert.equal((await f.request("/api/history/catalog", { path: "/private" })).status, 400);
  for (const entries of [[{ ...entry, path: "/private" }], [{ ...entry, label: "x".repeat(121) }], [{ ...entry, description: "x".repeat(301) }],
    [{ ...entry, label: "bad\nlabel" }], Array.from({ length: 257 }, () => ({ ...entry })), [entry, { ...entry }]]) {
    const invalid = await fixture(t, { listCatalog: () => entries });
    assert.equal((await invalid.request("/api/history/catalog", {})).data.code, "history_response_invalid");
  }
});

test("late aborted registration uses its exact private receipt to retire only an unclaimed row", async t => {
  const { createHistoryRegistry } = require("../protocol/native/claude/history-registry");
  const { createSourceService } = require("../protocol/native/claude/history-source-service");
  const registry = createHistoryRegistry({ sourceService: createSourceService(),
    catalog: [{ catalogId: "synthetic", source: { projectsRoot: path.resolve("/synthetic/projects"), projectKey: "fixture", sessionId: SESSION } }],
    authorize: () => true, principalActive: () => true });
  t.after(async () => { assert.equal((await registry.shutdown()).cleanupConfirmed, true); });
  let finish, receipt, cancelled;
  const f = await fixture(t, { deadlineMs: 30,
    register(principal, body) { receipt = registry.register(principal, body); return new Promise(resolve => { finish = () => resolve(receipt); }); },
    current: (principal, scope) => registry.current(principal, scope),
    cancelRegistration(principal, value) { assert.strictEqual(value, receipt); cancelled = registry.cancelRegistration(principal, value); },
  });
  const result = await f.request("/api/history/registrations", REG); assert.equal(result.status, 408);
  assert.equal(registry.status().activeSlots, 1); // Reply still has not yielded its receipt to HTTP.
  finish(); await delay(5); assert.equal(cancelled, true); assert.equal(registry.status().activeSlots, 0); assert.equal(registry.status().idleSlots, 1);
});

test("an aborted old registration cannot cancel a newer same-view renewal or an already claimed row", async t => {
  const { createHistoryRegistry } = require("../protocol/native/claude/history-registry");
  const { createSourceService } = require("../protocol/native/claude/history-source-service");
  for (const mode of ["renewed", "claimed"]) {
    const registry = createHistoryRegistry({ sourceService: createSourceService(),
      catalog: [{ catalogId: "synthetic", source: { projectsRoot: path.resolve("/synthetic/projects"), projectKey: "fixture", sessionId: SESSION } }],
      authorize: () => true, principalActive: () => true });
    t.after(async () => { assert.equal((await registry.shutdown()).cleanupConfirmed, true); });
    let finish, receipt, count = 0, cancelled;
    const f = await fixture(t, { deadlineMs: 30,
      register(principal, body) {
        const value = registry.register(principal, body);
        if (++count > 1) return value;
        receipt = value; return new Promise(resolve => { finish = () => resolve(value); });
      }, current: (principal, scope) => registry.current(principal, scope),
      cancelRegistration(principal, value) { assert.strictEqual(value, receipt); cancelled = registry.cancelRegistration(principal, value); },
    });
    assert.equal((await f.request("/api/history/registrations", REG)).status, 408);
    if (mode === "renewed") assert.equal((await f.request("/api/history/registrations", REG)).status, 200);
    else {
      const value = await registry.observe("browser:synthetic", { bindingId: receipt.bindingId, generation: receipt.generation, viewId: VIEW,
        requestId: REQUEST, page: PAGE.page });
      assert.equal(value.kind, "source_unavailable"); // No SDK configured, so no child or filesystem access.
    }
    finish(); await delay(5); assert.equal(cancelled, false, mode); assert.equal(registry.status().activeSlots, 1, mode);
  }
});

test("registration auth loss before publication cancels the original receipt, without fabricating cleanup", async t => {
  let receipt, cancelled;
  const f = await fixture(t, {
    register(_principal, body, _options, state) {
      receipt = Object.freeze({ kind: "history_registration", ...body, bindingId: BINDING, generation: 1, sessionId: SESSION,
        expiresAt: Date.now() + 60000, sourceAuthenticated: false, publishable: false });
      state.active = false; return receipt;
    }, cancelRegistration(principal, value) { assert.equal(principal, "browser:synthetic"); assert.strictEqual(value, receipt); cancelled = true; return true; },
  });
  const result = await f.request("/api/history/registrations", REG); assert.equal(result.status, 401); assert.equal(cancelled, true);
  assert.equal(result.data.cleanupConfirmed, undefined);
});
