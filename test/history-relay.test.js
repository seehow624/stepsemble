"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http"), zlib = require("node:zlib");
const { once } = require("node:events");
const { createHistoryRelayHandler, MAX_FLIGHTS, MAX_BINDINGS } = require("../server/history-relay");
const { LIMITS, VIEW_HEADER, CSRF_HEADER } = require("../server/history-http");
const fixture = require("../protocol/native/claude/history-fixture.cjs");
const { parseHistoryBytes } = require("../protocol/native/claude/history-source"), { selectHistory } = require("../protocol/native/claude/history-selection");
const VIEW = fixture.uuid(9001), BINDING = fixture.uuid(9002), REQUEST = fixture.uuid(9003);
const ORIGIN = "https://gateway.example:9443", PEER = "a".repeat(64), GRANT = "b".repeat(32);
const PAGE = { bindingId: BINDING, generation: 1, requestId: REQUEST, page: { offset: 0, limit: 2 } };
const REG = { catalogId: "synthetic", viewId: VIEW }, ENTRY = { catalogId: "synthetic", label: "Synthetic", description: "Owned fixture" };
const SOURCE = fixture.richCases("/synthetic/workspace")[0];
const unavailable = { kind: "source_unavailable", code: "source_busy" };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function history() {
  const parsed = parseHistoryBytes(Buffer.from(SOURCE.records.map(r => JSON.stringify(r)).join("\n") + "\n"), SOURCE.sessionId);
  return selectHistory({ ...parsed, kind: "source_snapshot", identity: { device: "1", inode: "2", size: parsed.byteLength, mtimeNs: "3", ctimeNs: "4" },
    checks: { owner: "posix_euid_and_mode", reads: 2, matchingBytes: true, unchangedObservedIdentity: true }, sourceAuthenticated: false, publishable: false }, PAGE.page,
  async (sessionId, options) => {
    await options.sessionStore.load({ projectKey: options.dir.replace(/[^a-zA-Z0-9]/g, "-"), sessionId });
    return fixture.selectedRows(SOURCE).slice(0, 2);
  });
}
async function bound() {
  return { kind: "bound_history_observation", bindingId: BINDING, generation: 1, requestId: REQUEST, sourceVersion: "c".repeat(64), sourceAuthenticated: false, publishable: false,
    cleanupConfirmed: true, history: await history() };
}
function registration(viewId = VIEW) {
  return { kind: "history_registration", ...REG, viewId, bindingId: BINDING, generation: 1, sessionId: SOURCE.sessionId,
    expiresAt: Date.now() + 60000, sourceAuthenticated: false, publishable: false };
}
async function listen(t, callback) {
  const server = http.createServer(callback); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
async function harness(t, { upstream, deadlineMs = 500, resolvePeer, fetchFn, seedRegistration = true, principalCheck } = {}) {
  const received = [], completed = [], signals = [];
  const state = { active: true, peer: true, selected: true, grantId: GRANT, closes: 0 }; let seeding = true;
  const port = await listen(t, async (req, res) => {
    res.on("close", () => { state.closes++; });
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const row = { url: req.url, method: req.method, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }; received.push(row);
    if (upstream && !seeding) return upstream(row, res, state);
    const value = row.url.endsWith("/catalog") ? { kind: "history_catalog", entries: [ENTRY], sourceAuthenticated: false, publishable: false }
      : row.method === "DELETE" ? { kind: "history_released", cleanupConfirmed: false } : row.url.endsWith("/registrations") ? registration(row.body.viewId) : await bound();
    // The remote's response headers must never become gateway credentials/CORS.
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "remote-secret=bad", "www-authenticate": "Bearer remote-secret",
      "access-control-allow-origin": "*", "x-remote-path": "/private/remote" }); res.end(JSON.stringify(value));
  });
  const url = `http://127.0.0.1:${port}`;
  const auth = { authenticateBrowserCookie: (name, value) => name === "stepsemble" && ["synthetic-cookie", "synthetic-other"].includes(value) && state.active
      ? value === "synthetic-cookie" ? "browser:synthetic" : "browser:other" : null,
    authenticatePeerCredential: () => "peer:incoming", isPrincipalCurrent: () => principalCheck ? principalCheck(state) : state.active };
  const relay = createHistoryRelayHandler({ auth, allowedOrigins: [ORIGIN], deadlineMs,
    resolvePeer: resolvePeer || (id => id === "remote" && state.selected ? { url, grantId: state.grantId, credential: PEER } : null),
    isPeerCurrent: () => state.peer, fetch: (target, init) => { signals.push(init.signal); return (seeding ? fetch : fetchFn || fetch)(target, init); } });
  t.after(() => relay.shutdown());
  const gateway = await listen(t, async (req, res) => {
    const before = [req.listenerCount("aborted"), res.listenerCount("close"), res.listenerCount("error")], original = req.url;
    const handled = await relay(req, res);
    completed.push({ before, after: [req.listenerCount("aborted"), res.listenerCount("close"), res.listenerCount("error")], original, restored: req.url });
    if (!handled) res.writeHead(404).end();
  });
  const headers = { cookie: "stepsemble=synthetic-cookie", origin: ORIGIN, "content-type": "application/json", [VIEW_HEADER]: VIEW, [CSRF_HEADER]: "1" };
  const request = (path = "/r/remote/api/history/page", body = PAGE, changes = {}, method = "POST") => new Promise((resolve, reject) => {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const hs = { ...headers, ...changes }; for (const name of Object.keys(hs)) if (hs[name] === undefined) delete hs[name];
    if (method === "DELETE") hs["content-length"] = raw.length;
    const req = http.request({ hostname: "127.0.0.1", port: gateway, path, method, headers: hs }, res => {
      const chunks = []; let size = 0;
      res.on("data", chunk => { size += chunk.length; if (size > LIMITS.responseBytes) return res.destroy(new Error("unbounded gateway response")); chunks.push(chunk); });
      res.on("error", reject); res.on("end", () => { const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, bytes,
        data: bytes.length ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) : null }); });
    }); req.on("error", reject); req.end(raw);
  });
  if (seedRegistration) {
    assert.equal((await request("/r/remote/api/history/registrations", REG)).status, 200);
    received.length = completed.length = signals.length = 0;
  }
  seeding = false;
  return { request, received, completed, state, relay, gateway, headers, signals, url };
}

test("actual HTTP relay only sends dedicated peer bearer and fixed inert catalog/register/page/release", async t => {
  const f = await harness(t);
  assert.equal((await f.request("/r/remote/api/history/catalog", {})).data.entries[0].catalogId, "synthetic");
  assert.equal((await f.request("/r/remote/api/history/registrations", REG)).data.kind, "history_registration");
  const page = await f.request(); assert.equal(page.status, 200); assert.equal(page.data.kind, "bound_history_observation");
  assert.deepEqual((await f.request(`/r/remote/api/history/registrations/${BINDING}`, { generation: 1 }, {}, "DELETE")).data, { kind: "history_released", cleanupConfirmed: false });
  for (const row of f.received) {
    assert.equal(row.headers.authorization, `Bearer ${PEER}`); assert.equal(row.headers.cookie, undefined); assert.equal(row.headers.origin, undefined);
    assert.equal(row.headers[CSRF_HEADER], undefined);
    if (!row.url.endsWith("/catalog")) assert.notEqual(row.headers[VIEW_HEADER], VIEW);
    assert.ok(!row.url.includes("/r/"));
  }
  assert.deepEqual(f.received[2].body, PAGE);
  for (const name of ["set-cookie", "www-authenticate", "access-control-allow-origin", "x-remote-path"]) assert.equal(page.headers[name], undefined);
  assert.equal(page.headers["cache-control"], "no-store"); assert.equal(Number(page.headers["content-length"]), page.bytes.length);
  assert.ok(f.completed.every(v => JSON.stringify(v.before) === JSON.stringify(v.after) && v.original === v.restored));
});

test("relay requires browser origin/CSRF/JSON and rejects all inbound bearer or mixed credentials", async t => {
  const f = await harness(t);
  for (const headers of [{ origin: undefined }, { origin: "http://gateway.example:9443" }, { origin: "https://evil.invalid", host: "evil.invalid" },
    { [CSRF_HEADER]: undefined }, { authorization: `Bearer ${PEER}` }, { authorization: `Bearer ${PEER}`, cookie: undefined }, { "content-type": "text/plain" }]) {
    const result = await f.request(undefined, PAGE, headers); assert.notEqual(result.status, 200);
  }
  assert.equal(f.received.length, 0); assert.equal(f.signals.length, 0);
});

test("no legacy cookie fallback, only trusted canonical peer origin and strict fixed route/body", async t => {
  for (const peer of [null, { url: "http://127.0.0.1:9" }, { url: "https://host.invalid?token=secret", credential: PEER, grantId: GRANT },
    { url: "https://user:pass@host.invalid", credential: PEER, grantId: GRANT }, { url: "https://host.invalid/path", credential: PEER, grantId: GRANT }]) {
    const f = await harness(t, { resolvePeer: () => peer, seedRegistration: false });
    assert.equal((await f.request()).data.code, "history_source_unavailable"); assert.equal(f.signals.length, 0);
  }
  const f = await harness(t);
  for (const field of ["url", "credential", "source", "sdkPath", "path", "env", "viewId"]) assert.equal((await f.request(undefined, { ...PAGE, [field]: "secret" })).status, 400);
  assert.equal((await f.request("/r/remote/api/history/page?url=evil")).status, 405);
  assert.equal((await f.request("/r/remote/api/history/resume")).status, 405);
  assert.equal((await f.request("/r/remote/api/history/page", PAGE, {}, "GET")).status, 405);
  assert.equal((await f.request("/r/unknown/api/history/page")).data.code, "history_source_unavailable");
  assert.equal((await f.request("/r/remote/api/session")).status, 404);
  assert.equal(f.signals.length, 0);
});

test("oversized or malformed upload is rejected before any peer fetch", async t => {
  const f = await harness(t);
  assert.equal((await f.request(undefined, Buffer.from(" ".repeat(LIMITS.requestBytes + 1)))).status, 413);
  assert.equal((await f.request(undefined, Buffer.from([0xc3, 0x28]))).status, 400);
  assert.equal(f.signals.length, 0);
});

test("decompressed gzip bytes are capped even when actual Content-Length is tiny", async t => {
  const bytes = zlib.gzipSync(Buffer.from(JSON.stringify({ padding: "x".repeat(LIMITS.responseBytes + 1) })));
  const f = await harness(t, { upstream: (_row, res) => { res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": bytes.length }); res.end(bytes); } });
  const result = await f.request(); assert.equal(result.data.code, "history_response_too_large"); assert.notEqual(result.status, 200);
  assert.ok(result.bytes.length < 200); assert.equal(f.signals[0].aborted, true);
});

test("actual HTTP malformed UTF-8/BOM/truncated JSON/non-JSON type and false authority cannot cross relay", async t => {
  for (const mode of ["utf8", "bom", "truncated", "type", "authority", "provider", "scope", "extra", "secretError"]) {
    const f = await harness(t, { upstream: async (_row, res) => {
      const value = await bound();
      if (mode === "authority") value.history.observation.authority.resumeAllowed = true;
      if (mode === "provider") value.history.reader.sdkVersion = "unreviewed";
      if (mode === "scope") value.requestId = fixture.uuid(9999);
      if (mode === "extra") value.extra = "SYNTHETIC_PRIVATE";
      let raw = Buffer.from(JSON.stringify(mode === "secretError" ? { kind: "source_unavailable", code: "SYNTHETIC_PRIVATE" } : value));
      if (mode === "utf8") raw = Buffer.from([0xc3, 0x28]);
      if (mode === "bom") raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]);
      if (mode === "truncated") raw = raw.subarray(0, -1);
      res.writeHead(200, { "content-type": mode === "type" ? "text/html" : "application/json" }); res.end(raw);
    } });
    const result = await f.request(); assert.notEqual(result.status, 200, mode); assert.ok(!result.bytes.includes(Buffer.from("SYNTHETIC_PRIVATE")), mode);
  }
});

test("false large/small Content-Length cannot turn partial response into a history reply", async t => {
  for (const declared of [8, 100000]) {
    const f = await harness(t, { upstream: async (_row, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": declared, connection: "close" }); res.end(JSON.stringify(await bound()));
    } });
    const result = await f.request(); assert.notEqual(result.status, 200); assert.ok(!result.bytes.includes(Buffer.from("bound_history_observation")));
  }
});

test("redirect and non-JSON upstream auth challenge are not forwarded", async t => {
  for (const status of [302, 401]) {
    const f = await harness(t, { upstream: (_row, res) => {
      res.writeHead(status, { location: "http://127.0.0.1:9/secret", "content-type": "text/plain", "set-cookie": "SYNTHETIC_PRIVATE", "www-authenticate": "SYNTHETIC_PRIVATE" }); res.end("SYNTHETIC_PRIVATE");
    } });
    const result = await f.request(); assert.notEqual(result.status, 200); assert.equal(f.received.length, 1);
    assert.ok(!result.bytes.includes(Buffer.from("SYNTHETIC_PRIVATE"))); assert.equal(result.headers["set-cookie"], undefined);
    assert.equal(result.headers["www-authenticate"], undefined); assert.equal(result.headers.location, undefined);
  }
});

test("slow response chunks time out and abort upstream without partial publish or listener leaks", async t => {
  const f = await harness(t, { deadlineMs: 45, upstream: (_row, res) => {
    res.writeHead(200, { "content-type": "application/json" }); res.write("{");
    const timer = setInterval(() => res.write(" "), 5); res.on("close", () => clearInterval(timer));
  } });
  const result = await f.request(); assert.equal(result.status, 408); assert.equal(result.data.code, "history_request_timeout");
  assert.equal(f.signals[0].aborted, true); assert.deepEqual(f.completed[0].before, f.completed[0].after);
});

test("browser disconnect aborts the active downstream stream and restores request state", async t => {
  let started; const ready = new Promise(resolve => { started = resolve; });
  const f = await harness(t, { upstream: (_row, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); started(); } });
  const req = http.request({ hostname: "127.0.0.1", port: f.gateway, path: "/r/remote/api/history/page", method: "POST", headers: f.headers });
  req.on("error", () => {}); req.end(JSON.stringify(PAGE)); await ready; req.destroy();
  for (let i = 0; i < 30 && !f.completed.length; i++) await delay(5);
  assert.equal(f.signals[0].aborted, true); assert.equal(f.completed.length, 1); assert.deepEqual(f.completed[0].before, f.completed[0].after);
  assert.equal(f.completed[0].restored, f.completed[0].original);
});

test("principal/peer revoke and shutdown fan out to in-flight downstream reads", async t => {
  for (const mode of ["principal", "peer", "shutdown"]) {
    let started; const ready = new Promise(resolve => { started = resolve; });
    const f = await harness(t, { upstream: (_row, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); started(); } });
    const pending = f.request(); await ready;
    if (mode === "principal") { f.state.active = false; f.relay.revokePrincipal("browser:synthetic"); }
    if (mode === "peer") { f.state.peer = false; f.relay.revokePeer("remote"); }
    if (mode === "shutdown") f.relay.shutdown();
    const result = await pending; assert.notEqual(result.status, 200); assert.equal(f.signals[0].aborted, true);
    assert.ok(!result.bytes.includes(Buffer.from("bound_history_observation"))); assert.deepEqual(f.completed[0].before, f.completed[0].after);
  }
});

test("current principal/grant recheck drops completed responses after revoke or target rotation", async t => {
  for (const mode of ["principal", "peer", "grant"]) {
    const f = await harness(t, { upstream: async (_row, res, state) => {
      const value = await bound();
      if (mode === "principal") state.active = false; if (mode === "peer") state.peer = false; if (mode === "grant") state.grantId = "e".repeat(32);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value));
    } });
    const result = await f.request(); assert.notEqual(result.status, 200); assert.ok(!result.bytes.includes(Buffer.from("bound_history_observation")));
  }
});

test("trusted fetch adapters still receive omit/redirect error and cannot force unbounded json()", async t => {
  const f = await harness(t, { fetchFn: async (_url, init) => {
    assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error");
    const response = new Response(JSON.stringify(unavailable), { status: 409, headers: { "content-type": "application/json", "content-length": "1" } });
    response.json = () => assert.fail("unbounded response.json()"); response.text = () => assert.fail("unbounded response.text()"); return response;
  } });
  assert.deepEqual((await f.request()).data, unavailable); assert.equal(f.received.length, 0);
});

test("deadline handles an ignored fetch abort and cancels its body if it arrives late", async t => {
  let finish, cancels = 0;
  const f = await harness(t, { deadlineMs: 35, fetchFn: () => new Promise(resolve => { finish = resolve; }) });
  const result = await f.request(); assert.equal(result.status, 408); assert.equal(f.signals[0].aborted, true);
  const body = new ReadableStream({ cancel() { cancels++; } });
  finish(new Response(body, { headers: { "content-type": "application/json" } }));
  await delay(5); assert.equal(cancels, 1); assert.equal(f.completed.length, 1); assert.deepEqual(f.completed[0].before, f.completed[0].after);
});

test("catalog/register/release requests propagate abort too, with no fabricated cleanup confirmation", async t => {
  for (const [path, body, method] of [["/r/remote/api/history/catalog", {}, "POST"], ["/r/remote/api/history/registrations", REG, "POST"],
    [`/r/remote/api/history/registrations/${BINDING}`, { generation: 1 }, "DELETE"]]) {
    let started; const ready = new Promise(resolve => { started = resolve; });
    const f = await harness(t, { upstream: (_row, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); started(); } });
    const pending = f.request(path, body, {}, method); await ready; f.relay.revokePeer("remote");
    const result = await pending; assert.notEqual(result.status, 200); assert.equal(f.signals[0].aborted, true); assert.equal(result.data.cleanupConfirmed, undefined);
  }
});

test("relay has a fixed concurrent flight cap and releases capacity after cancellation", async t => {
  let hold = true;
  const f = await harness(t, { deadlineMs: 2000, fetchFn: async () => hold ? new Promise(() => {})
    : new Response(JSON.stringify(unavailable), { status: 409, headers: { "content-type": "application/json" } }) });
  const pending = Array.from({ length: MAX_FLIGHTS }, () => f.request());
  for (let i = 0; i < 100 && f.signals.length < MAX_FLIGHTS; i++) await delay(5);
  assert.equal(f.signals.length, MAX_FLIGHTS);
  assert.equal((await f.request()).data.code, "history_capacity_unavailable"); assert.equal(f.signals.length, MAX_FLIGHTS);
  f.relay.revokePeer("remote"); const results = await Promise.all(pending); assert.ok(results.every(value => value.status !== 200));
  hold = false;
  assert.equal((await f.request()).data.code, "history_binding_unavailable");
  assert.deepEqual((await f.request("/r/remote/api/history/registrations", REG)).data, unavailable); assert.equal(f.signals.length, MAX_FLIGHTS + 1);
});

function ownedRemote({ cleanup = true } = {}) {
  const rows = new Map(); let sequence = 0;
  return { rows, async handle(request, res) {
    const viewId = request.headers[VIEW_HEADER]; let value;
    if (request.url.endsWith("/registrations")) {
      let row = rows.get(viewId);
      if (!row) { row = { ...registration(viewId), bindingId: fixture.uuid(9500 + sequence++), catalogId: request.body.catalogId }; rows.set(viewId, row); }
      value = { ...row, expiresAt: Date.now() + 60000 };
    } else if (request.method === "DELETE") {
      if (cleanup) rows.delete(viewId); value = { kind: "history_released", cleanupConfirmed: cleanup };
    } else {
      const row = rows.get(viewId);
      value = row ? { ...await bound(), bindingId: row.bindingId, generation: row.generation, requestId: request.body.requestId }
        : { kind: "source_unavailable", code: "history_binding_unavailable" };
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value));
  } };
}

test("gateway ownership blocks stolen view/binding across browser principals before peer fetch", async t => {
  const remote = ownedRemote(), f = await harness(t, { seedRegistration: false, upstream: remote.handle });
  const other = { cookie: "stepsemble=synthetic-other" };
  const a = (await f.request("/r/remote/api/history/registrations", REG)).data;
  const requestA = { ...PAGE, bindingId: a.bindingId, generation: a.generation };
  const before = f.signals.length;
  assert.equal((await f.request(undefined, requestA, other)).data.code, "history_binding_unavailable");
  assert.equal((await f.request(`/r/remote/api/history/registrations/${a.bindingId}`, { generation: a.generation }, other, "DELETE")).data.code, "history_binding_unavailable");
  assert.equal(f.signals.length, before);
  // The same browser-supplied view ID is not a remote authority token. Each
  // local principal receives its own gateway-generated upstream view.
  const b = (await f.request("/r/remote/api/history/registrations", REG, other)).data;
  assert.equal(a.viewId, VIEW); assert.equal(b.viewId, VIEW); assert.notEqual(a.bindingId, b.bindingId);
  const registrations = f.received.filter(r => r.url.endsWith("/registrations"));
  assert.notEqual(registrations[0].body.viewId, registrations[1].body.viewId);
  assert.ok(registrations.every(r => r.body.viewId !== VIEW && !JSON.stringify(r.body).includes("browser:")));
  assert.equal((await f.request(undefined, requestA)).status, 200);
  assert.equal((await f.request(undefined, { ...PAGE, bindingId: b.bindingId }, other)).status, 200);
  assert.equal((await f.request(undefined, { ...PAGE, bindingId: b.bindingId })).data.code, "history_binding_unavailable");
});

test("only a validated successful registration publishes ownership; failed attempts never reuse the remote view", async t => {
  let invalid = true; const views = [];
  const f = await harness(t, { seedRegistration: false, upstream: (row, res) => {
    views.push(row.body.viewId);
    const value = { ...registration(row.body.viewId), ...(invalid ? { nativePath: "/private/never" } : {}) };
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value));
  } });
  assert.equal((await f.request("/r/remote/api/history/registrations", REG)).data.code, "history_response_invalid");
  const before = f.signals.length;
  assert.equal((await f.request()).data.code, "history_binding_unavailable"); assert.equal(f.signals.length, before);
  invalid = false; assert.equal((await f.request("/r/remote/api/history/registrations", REG)).status, 200);
  assert.notEqual(views[0], views[1]);
});

test("remote slot transfer fences an old browser owner and rejects generation rollback", async t => {
  let generation = 1;
  const f = await harness(t, { seedRegistration: false, upstream: (row, res) => {
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ...registration(row.body.viewId), generation }));
  } });
  assert.equal((await f.request("/r/remote/api/history/registrations", REG)).status, 200);
  generation = 2;
  assert.equal((await f.request("/r/remote/api/history/registrations", REG, { cookie: "stepsemble=synthetic-other" })).status, 200);
  const before = f.signals.length;
  assert.equal((await f.request()).data.code, "history_binding_unavailable"); assert.equal(f.signals.length, before);
  generation = 1;
  assert.equal((await f.request("/r/remote/api/history/registrations", REG, { cookie: "stepsemble=synthetic-other" })).data.code, "history_response_invalid");
});

test("bounded gateway rows retain unconfirmed closing ownership and release capacity on explicit revoke", async t => {
  const remote = ownedRemote({ cleanup: false }), f = await harness(t, { seedRegistration: false, upstream: remote.handle });
  const rows = [];
  for (let i = 0; i < MAX_BINDINGS; i++) {
    const viewId = fixture.uuid(10000 + i), headers = { [VIEW_HEADER]: viewId };
    const result = await f.request("/r/remote/api/history/registrations", { ...REG, viewId }, headers);
    assert.equal(result.status, 200); rows.push({ ...result.data, headers });
  }
  const extraView = fixture.uuid(11000), extraHeaders = { [VIEW_HEADER]: extraView }, before = f.signals.length;
  assert.equal((await f.request("/r/remote/api/history/registrations", { ...REG, viewId: extraView }, extraHeaders)).data.code, "history_capacity_unavailable");
  assert.equal(f.signals.length, before);
  const first = rows[0];
  assert.deepEqual((await f.request(`/r/remote/api/history/registrations/${first.bindingId}`, { generation: first.generation }, first.headers, "DELETE")).data,
    { kind: "history_released", cleanupConfirmed: false });
  assert.equal((await f.request(undefined, { ...PAGE, bindingId: first.bindingId }, first.headers)).data.code, "history_binding_unavailable");
  assert.equal((await f.request("/r/remote/api/history/registrations", { ...REG, viewId: extraView }, extraHeaders)).data.code, "history_capacity_unavailable");
  f.relay.revokePrincipal("browser:synthetic");
  assert.equal((await f.request("/r/remote/api/history/registrations", { ...REG, viewId: extraView }, extraHeaders)).status, 200);
});

test("confirmed release removes ownership and source grant rotation requires a new registration", async t => {
  const remote = ownedRemote(), f = await harness(t, { seedRegistration: false, upstream: remote.handle });
  const a = (await f.request("/r/remote/api/history/registrations", REG)).data;
  assert.equal((await f.request(`/r/remote/api/history/registrations/${a.bindingId}`, { generation: 1 }, {}, "DELETE")).data.cleanupConfirmed, true);
  assert.equal((await f.request(undefined, { ...PAGE, bindingId: a.bindingId })).data.code, "history_binding_unavailable");
  const b = (await f.request("/r/remote/api/history/registrations", REG)).data;
  f.state.grantId = "c".repeat(32);
  assert.equal((await f.request(undefined, { ...PAGE, bindingId: b.bindingId })).data.code, "history_binding_unavailable");
  const c = (await f.request("/r/remote/api/history/registrations", REG)).data;
  assert.equal(c.kind, "history_registration"); assert.notEqual(c.bindingId, b.bindingId);
});

test("release fences an active page before remote cleanup and cannot publish its late bytes", async t => {
  let started; const ready = new Promise(resolve => { started = resolve; });
  const f = await harness(t, { upstream: (row, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (row.method === "DELETE") res.end(JSON.stringify({ kind: "history_released", cleanupConfirmed: false }));
    else { res.write("{"); started(); }
  } });
  const pending = f.request(); await ready;
  const released = await f.request(`/r/remote/api/history/registrations/${BINDING}`, { generation: 1 }, {}, "DELETE");
  assert.deepEqual(released.data, { kind: "history_released", cleanupConfirmed: false });
  assert.notEqual((await pending).status, 200); assert.equal(f.signals[0].aborted, true);
  const calls = f.signals.length;
  assert.equal((await f.request()).data.code, "history_binding_unavailable"); assert.equal(f.signals.length, calls);
});

test("remote lease expiry after bytes arrive is rechecked before gateway publication", async t => {
  let started, finish; const ready = new Promise(resolve => { started = resolve; });
  const f = await harness(t, { seedRegistration: false, deadlineMs: 2000, upstream: async (row, res) => {
    if (row.url.endsWith("/registrations")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...registration(row.body.viewId), expiresAt: Date.now() + 1000 }));
    } else {
      const bytes = JSON.stringify(await bound()); res.writeHead(200, { "content-type": "application/json" }); res.write(bytes.slice(0, 10));
      finish = () => res.end(bytes.slice(10)); started();
    }
  } });
  assert.equal((await f.request("/r/remote/api/history/registrations", REG)).status, 200);
  const pending = f.request(); await ready; await delay(1050); finish();
  const result = await pending; assert.equal(result.data.code, "history_binding_unavailable"); assert.notEqual(result.status, 200);
  assert.ok(!result.bytes.includes(Buffer.from("bound_history_observation")));
});

function tentativeRemote({ failPage = false, unconfirmed = false } = {}) {
  const rows = new Map();
  return async (request, res) => {
    const viewId = request.headers[VIEW_HEADER]; let row = rows.get(viewId), value;
    if (request.url.endsWith("/registrations")) {
      if (request.body.catalogId === "denied") value = { kind: "source_unavailable", code: "history_source_unavailable" };
      else if (row && row.catalogId !== request.body.catalogId && row.claimed) value = { kind: "source_unavailable", code: "history_view_conflict" };
      else if (row && row.catalogId !== request.body.catalogId && unconfirmed) value = { kind: "source_unavailable", code: "source_cleanup_unconfirmed" };
      else {
        if (!row || row.catalogId !== request.body.catalogId) {
          row = { ...registration(viewId), catalogId: request.body.catalogId, generation: (row?.generation ?? 0) + 1, claimed: false }; rows.set(viewId, row);
        }
        const { claimed, ...descriptor } = row; value = descriptor;
      }
    } else {
      if (row) row.claimed = true;
      value = failPage ? { kind: "source_unavailable", code: "source_busy" } : { ...await bound(), generation: row.generation };
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value));
  };
}

test("same-owner unobserved catalog replacement delegates authorization and actual generation transfer to remote", async t => {
  const f = await harness(t, { seedRegistration: false, upstream: tentativeRemote() });
  const first = (await f.request("/r/remote/api/history/registrations", REG)).data;
  assert.equal((await f.request("/r/remote/api/history/registrations", { ...REG, catalogId: "denied" })).data.code, "history_source_unavailable");
  const second = (await f.request("/r/remote/api/history/registrations", { ...REG, catalogId: "second" })).data;
  assert.equal(second.kind, "history_registration"); assert.equal(second.bindingId, first.bindingId); assert.equal(second.generation, 2);
  assert.ok(f.received.every(r => r.body.viewId === f.received[0].body.viewId));
  const before = f.signals.length;
  assert.equal((await f.request(undefined, PAGE)).data.code, "history_binding_unavailable"); assert.equal(f.signals.length, before);
  assert.equal((await f.request(undefined, { ...PAGE, generation: 2 })).status, 200);
  const claimedCount = f.signals.length;
  assert.equal((await f.request("/r/remote/api/history/registrations", REG)).data.code, "history_view_conflict"); assert.equal(f.signals.length, claimedCount);
});

test("even failed observation permanently claims a gateway registration; uncertain replacement cleanup stays closing", async t => {
  const claimed = await harness(t, { seedRegistration: false, upstream: tentativeRemote({ failPage: true }) });
  await claimed.request("/r/remote/api/history/registrations", REG); assert.equal((await claimed.request()).data.code, "source_busy");
  assert.equal((await claimed.request("/r/remote/api/history/registrations", { ...REG, catalogId: "second" })).data.code, "history_view_conflict");
  const uncertain = await harness(t, { seedRegistration: false, upstream: tentativeRemote({ unconfirmed: true }) });
  await uncertain.request("/r/remote/api/history/registrations", REG);
  assert.equal((await uncertain.request("/r/remote/api/history/registrations", { ...REG, catalogId: "second" })).data.code, "source_cleanup_unconfirmed");
  const before = uncertain.signals.length;
  assert.equal((await uncertain.request()).data.code, "history_binding_unavailable");
  assert.equal((await uncertain.request("/r/remote/api/history/registrations", REG)).data.code, "history_view_conflict"); assert.equal(uncertain.signals.length, before);
});

test("HTTP private receipt cancellation fences only local tentative authority, then explicit replacement reconciles without DELETE", async t => {
  let checks = 0, deny = true;
  const f = await harness(t, { seedRegistration: false, upstream: tentativeRemote(), principalCheck: () => !(deny && ++checks === 5) });
  const rejected = await f.request("/r/remote/api/history/registrations", REG);
  assert.equal(rejected.status, 401); deny = false;
  const before = f.signals.length;
  assert.equal((await f.request()).data.code, "history_binding_unavailable"); assert.equal(f.signals.length, before);
  const replaced = await f.request("/r/remote/api/history/registrations", { ...REG, catalogId: "second" });
  assert.equal(replaced.status, 200); assert.equal(replaced.data.generation, 2);
  assert.equal(f.received[0].body.viewId, f.received[1].body.viewId);
  assert.ok(f.received.every(row => row.method !== "DELETE"));
});
