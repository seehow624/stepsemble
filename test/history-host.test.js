"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const { once } = require("node:events"), { spawn } = require("node:child_process"), { createHash } = require("node:crypto");
const { createHistoryHost, disabledHistoryHost, parseHistoryConfig, loadHistoryConfig, CONFIG_BYTES } = require("../server/history-host");
const { VIEW_HEADER, CSRF_HEADER } = require("../server/history-http");
const { uuid } = require("../protocol/native/claude/history-fixture.cjs");
const origin = "https://synthetic.invalid", viewId = uuid(910), grantId = "d".repeat(32);
const hash = n => n.toString(16).padStart(64, "0");
const config = () => ({ version: 1, trustBoundary: "host_managed_paths", allowedOrigins: [origin],
  reader: { helperPath: path.resolve("synthetic-reader"), sdkPath: path.resolve("synthetic-sdk/sdk.mjs") },
  catalog: [{ catalogId: "one", label: "合成來源", description: "Not a private session",
    source: { projectsRoot: path.resolve("synthetic-projects"), projectKey: "-workspace", sessionId: uuid(911) },
    expectedRoot: { device: "1", inode: "2" }, readers: ["browser:master"] }] });
const registration = id => ({ catalogId: id, viewId });
const page = r => ({ bindingId: r.bindingId, generation: r.generation, requestId: uuid(912), page: { offset: 0, limit: 10 } });
const unavailable = code => ({ kind: "source_unavailable", code });
function syntheticService() {
  const rows = []; let resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const state = { hold: false, shutdowns: 0, started, rows };
  const service = { bind(input) {
    const row = { revoked: false, active: false, stop: null }; rows.push(row);
    return { kind: "bound_source", descriptor: { bindingId: input.bindingId, generation: input.generation, sessionId: input.source.sessionId },
      revoke() { row.revoked = true; row.stop?.(); },
      status: () => ({ revoked: row.revoked, activeWorker: row.active, cleanupConfirmed: !row.active }),
      async observe(_r, { signal }) {
        if (!state.hold) return unavailable("source_acl_unsupported");
        row.active = true;
        return new Promise(resolve => {
          const stop = () => { row.active = false; signal.removeEventListener("abort", stop); resolve(unavailable("source_aborted")); };
          row.stop = stop; signal.addEventListener("abort", stop, { once: true }); resolveStarted();
          if (signal.aborted) stop();
        });
      } };
  }, status: () => ({ closed: false, quarantined: false, retainedBindings: rows.length, activeWorkers: rows.filter(r => r.active).length }),
  async shutdown() { state.shutdowns++; for (const r of rows) { r.revoked = true; r.stop?.(); } return { cleanupConfirmed: true }; } };
  return { state, service };
}
async function listen(t, host) {
  const server = http.createServer(async (req, res) => { if (!await host.handle(req, res)) res.writeHead(404).end(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await host.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
async function request(port, route = "/api/history/catalog", body = {}, overrides = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: {
    cookie: `stepsemble=${hash(1)}`, origin, "content-type": "application/json", [VIEW_HEADER]: viewId, [CSRF_HEADER]: "1", ...overrides }, body: JSON.stringify(body) });
  const text = await response.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: response.status, headers: response.headers, data, text };
}
function setup(input = config()) {
  let readerOptions;
  const { service, state } = syntheticService();
  const authority = { browser: [{ id: "master", hash: hash(1) }, { id: "12345678", hash: hash(2) }], peers: [grantId], peer: null };
  const host = createHistoryHost({ config: input, browserCredentials: () => authority.browser, peerGrantIds: () => authority.peers,
    authenticatePeerCredential: v => v === hash(3) && authority.peers.includes(grantId) ? { grantId } : null,
    resolvePeer: () => authority.peer, sourceServiceFactory: options => { readerOptions = options; return service; } });
  return { host, state, authority, readerOptions };
}
test("Host configuration is explicit, detached, strictly bounded and has per-credential source grants", () => {
  const input = config(), result = parseHistoryConfig(input); input.catalog[0].readers.push("*");
  assert.deepEqual(result.catalog[0].readers, ["browser:master"]);
  const bad = [c => { c.extra = true; }, c => { delete c.trustBoundary; }, c => { c.reader = null; }, c => { c.allowedOrigins = [origin + "/"]; },
    c => { c.catalog[0].source.projectKey = "../private"; }, c => { c.catalog[0].expectedRoot.inode = "18446744073709551616"; },
    c => { c.catalog[0].readers = ["*"]; }, c => { c.catalog[0].readers = ["browser:master", "browser:master"]; },
    c => { c.catalog.push({ ...structuredClone(c.catalog[0]), catalogId: "two", expectedRoot: { device: "1", inode: "9" } }); },
    c => { c.catalog[0].label = "x".repeat(CONFIG_BYTES); }, c => { c.reader.sdkPath = path.resolve("sdk.cjs"); }];
  for (const mutate of bad) { const c = config(); mutate(c); assert.throws(() => parseHistoryConfig(c), /configuration_invalid/); }
  let invoked = 0; const c = config(); Object.defineProperty(c, "version", { enumerable: true, get() { invoked++; return 1; } });
  assert.throws(() => parseHistoryConfig(c), /configuration_invalid/); assert.equal(invoked, 0);
  assert.equal(parseHistoryConfig({ ...config(), reader: null, catalog: [] }).reader, null);
});
test("bounded startup config rejects symlinks, permissive files, oversize and missing executables", { skip: process.platform === "win32" }, t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-history-config-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, "history.json"), c = { ...config(), reader: null, catalog: [] };
  fs.writeFileSync(filename, JSON.stringify(c), { mode: 0o600 }); assert.deepEqual(loadHistoryConfig(filename), c);
  const alias = path.join(dir, "alias.json"); fs.symlinkSync(filename, alias); assert.throws(() => loadHistoryConfig(alias), /configuration_invalid/);
  fs.chmodSync(filename, 0o644); assert.throws(() => loadHistoryConfig(filename), /configuration_invalid/); fs.chmodSync(filename, 0o600);
  fs.writeFileSync(filename, "x".repeat(CONFIG_BYTES + 1)); assert.throws(() => loadHistoryConfig(filename), /configuration_invalid/);
  fs.writeFileSync(filename, JSON.stringify(config())); assert.throws(() => loadHistoryConfig(filename), /configuration_invalid/);
  fs.writeFileSync(filename, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(c))]));
  assert.throws(() => loadHistoryConfig(filename), /configuration_invalid/);
});
test("synthetic staging isolates hard-linked artifacts without weakening Host configuration policy", { skip: process.platform === "win32" }, async t => {
  const { stageSyntheticArtifact } = await import("../scripts/history-host-synthetic.mjs");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-history-artifact-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const helper = path.join(dir, "cargo-reader"), alias = path.join(dir, "cargo-deps-reader"), sdkPath = path.join(dir, "sdk.mjs");
  fs.writeFileSync(helper, "owned synthetic executable, never invoked", { mode: 0o755 }); fs.linkSync(helper, alias);
  fs.writeFileSync(sdkPath, "owned synthetic SDK, never imported", { mode: 0o600 });
  const c = { ...config(), reader: { helperPath: helper, sdkPath } }, filename = path.join(dir, "history.json");
  fs.writeFileSync(filename, JSON.stringify(c), { mode: 0o600 });
  assert.throws(() => loadHistoryConfig(filename), /configuration_invalid/);
  const before = fs.statSync(helper, { bigint: true }), staged = path.join(dir, "private-reader");
  const result = await stageSyntheticArtifact(helper, staged, 0o500);
  assert.equal(result.sourceLinks, 2); assert.equal(result.stagedLinks, 1); assert.equal(result.stagedMode, 0o500);
  assert.ok(fs.readFileSync(staged).equals(fs.readFileSync(helper)));
  const after = fs.statSync(helper, { bigint: true });
  for (const key of ["dev", "ino", "size", "mode", "nlink", "ctimeNs", "mtimeNs"]) assert.equal(after[key], before[key], key);
  c.reader.helperPath = staged; fs.writeFileSync(filename, JSON.stringify(c)); assert.deepEqual(loadHistoryConfig(filename), c);
  // Unsafe modes on either artifact still fail closed, independent of staging.
  fs.chmodSync(staged, 0o520); assert.throws(() => loadHistoryConfig(filename), /configuration_invalid/); fs.chmodSync(staged, 0o500);
  fs.chmodSync(sdkPath, 0o620); assert.throws(() => loadHistoryConfig(filename), /configuration_invalid/);
});
test("synthetic artifact staging never overwrites an existing output or changes shared input modes", { skip: process.platform === "win32" }, async t => {
  const { stageSyntheticArtifact } = await import("../scripts/history-host-synthetic.mjs");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-history-artifact-exclusive-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source"), destination = path.join(dir, "destination");
  fs.writeFileSync(source, "synthetic input", { mode: 0o755 }); fs.writeFileSync(destination, "preserve output", { mode: 0o600 });
  await assert.rejects(stageSyntheticArtifact(source, destination, 0o500), { code: "EEXIST" });
  assert.equal(fs.readFileSync(destination, "utf8"), "preserve output"); assert.equal(fs.statSync(source).mode & 0o777, 0o755);
  await assert.rejects(stageSyntheticArtifact(source, path.join(dir, "invalid"), 0o777), /mode_invalid/);
  assert.equal(fs.existsSync(path.join(dir, "invalid")), false);
});
test("disabled history reserves local and remote namespaces without swallowing unrelated routes", async t => {
  const port = await listen(t, disabledHistoryHost());
  for (const route of ["/api/history", "/api/history/catalog", "/r/mini/api/history/page", "/r/INVALID/api/history/catalog"])
    assert.equal((await request(port, route)).status, 503);
  assert.equal((await request(port, "/api/health")).status, 404);
});
test("normalized URL aliases cannot fall through to the legacy relay", async t => {
  for (const host of [disabledHistoryHost(), setup().host]) {
    t.after(() => host.shutdown());
    for (const url of ["/api/./history/catalog", "/r/mini/api/a/../history/page", "/r/mini/api/%2e/history/page", "http://example.invalid/api/history/catalog"]) {
      let code, body;
      const res = { writeHead(status) { code = status; }, end(value) { body = value; } };
      assert.equal(await host.handle({ url }, res), true); assert.equal(code, 503);
      assert.equal(JSON.parse(body).kind, "source_unavailable");
    }
  }
});
test("real HTTP filters catalog by private credential identity and denies binds before source use", async t => {
  const c = config(); c.catalog.push({ ...structuredClone(c.catalog[0]), catalogId: "peer-only", readers: [`peer:${grantId}`] });
  const h = setup(c), port = await listen(t, h.host);
  const master = await request(port); assert.deepEqual(master.data.entries.map(e => e.catalogId), ["one"]);
  assert.ok(!master.text.includes("projectsRoot")); assert.ok(!master.text.includes("browser:master"));
  assert.deepEqual((await request(port, undefined, {}, { cookie: `stepsemble=${hash(2)}` })).data.entries, []);
  assert.equal((await request(port, "/api/history/registrations", registration("one"), { cookie: `stepsemble=${hash(2)}` })).status, 409);
  assert.equal(h.state.rows.length, 0);
  const peer = await request(port, undefined, {}, { cookie: "", authorization: `Bearer ${hash(3)}` });
  // Empty Cookie is still mixed authority: do not normalize it away.
  assert.equal(peer.status, 401);
  const peerResponse = await fetch(`http://127.0.0.1:${port}/api/history/catalog`, { method: "POST", headers: {
    authorization: `Bearer ${hash(3)}`, "content-type": "application/json", [VIEW_HEADER]: viewId }, body: "{}" });
  assert.deepEqual((await peerResponse.json()).entries.map(e => e.catalogId), ["peer-only"]);
  const reg = await request(port, "/api/history/registrations", registration("one")); assert.equal(reg.status, 200);
  assert.equal(reg.data.sourceAuthenticated, false);
  assert.equal((await request(port, "/api/history/page", page(reg.data))).data.code, "source_acl_unsupported");
});
test("all cookie alias logout and token deletion abort reads; old bindings never revive", async t => {
  for (const mode of ["stepsemble", "pi_harbor", "pi_web", "revoke"]) {
    const h = setup(), port = await listen(t, h.host);
    const reg = (await request(port, "/api/history/registrations", registration("one"))).data;
    h.state.hold = true; const pending = request(port, "/api/history/page", page(reg)); await h.state.started;
    if (mode === "revoke") { h.authority.browser = []; h.host.credentialsChanged(); }
    else h.host.logout({ headers: { cookie: `unrelated=x; ${mode}=${hash(1)}` } });
    assert.equal(h.state.rows[0].revoked, true); assert.equal(h.state.rows[0].active, false);
    assert.notEqual((await pending).status, 200);
    assert.notEqual((await request(port, "/api/history/page", page(reg))).status, 200);
    if (mode !== "revoke") {
      const next = (await request(port, "/api/history/registrations", registration("one"))).data;
      assert.ok(next.generation > reg.generation || next.bindingId !== reg.bindingId);
    }
  }
});
test("Host relay uses dedicated grant only, accepts canonical trailing slash and revokes peer bindings", async t => {
  const remoteConfig = config(); remoteConfig.catalog[0].readers = [`peer:${grantId}`];
  const remote = setup(remoteConfig), remotePort = await listen(t, remote.host);
  const gateway = setup({ ...config(), reader: null, catalog: [] }), port = await listen(t, gateway.host);
  gateway.authority.peer = { url: `http://127.0.0.1:${remotePort}/`, credential: hash(3), grantId };
  const cat = await request(port, "/r/mini/api/history/catalog"); assert.equal(cat.status, 200); assert.equal(cat.data.entries.length, 1);
  const reg = (await request(port, "/r/mini/api/history/registrations", registration("one"))).data;
  assert.equal(reg.kind, "history_registration");
  gateway.host.peerChanged("mini");
  assert.equal((await request(port, "/r/mini/api/history/page", page(reg))).data.code, "history_binding_unavailable");
  gateway.authority.peer.url += "not-an-origin";
  assert.equal((await request(port, "/r/mini/api/history/catalog")).status, 503);
});
test("shutdown stops admission synchronously, is idempotent and waits source cleanup", async t => {
  const h = setup(), port = await listen(t, h.host);
  const first = h.host.shutdown(), second = h.host.shutdown(); assert.equal(first, second);
  assert.equal((await request(port)).data.code, "history_registry_closed");
  assert.deepEqual(await first, { kind: "history_registry_closed", cleanupConfirmed: true, quarantined: false }); assert.equal(h.state.shutdowns, 1);
});

test("actual Host owns its shared reader budget and includes unknown cleanup in shutdown result", async () => {
  const h = setup(), admission = h.readerOptions.admission;
  assert.equal(require("../protocol/native/claude/history-reader-admission").isReaderAdmission(admission), true);
  let actualClose = false, stopped = 0;
  const permit = admission.acquire(() => { stopped++; }, () => actualClose);
  permit.finish();
  assert.equal(h.host.status().admission.quarantined, true);
  const result = await h.host.shutdown();
  assert.equal(result.cleanupConfirmed, false); assert.equal(result.quarantined, true); assert.ok(stopped > 0);
  actualClose = true;
  assert.equal(h.host.status().admission.cleanupConfirmed, true); assert.equal(h.host.status().admission.quarantined, true);
  assert.equal((await h.host.shutdown()).cleanupConfirmed, false, "cached shutdown report must not rewrite an unknown cleanup into success");
});

test("actual server wires opt-in catalog, login/logout scope retirement, static entry and graceful shutdown", { skip: process.platform === "win32", timeout: 20000 }, async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-history-host-")));
  const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening"); const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const c = config(), helper = path.join(dir, "reader"), sdkPath = path.join(dir, "sdk.mjs");
  // A trusted synthetic helper stalls until Host cleanup kills it. It never
  // reads a source or publishes bytes, so the SDK must never execute.
  const marker = path.join(dir, "owned-helper.pid");
  fs.writeFileSync(helper, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));\nprocess.stdin.resume(); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  fs.writeFileSync(sdkPath, "throw new Error('must not import in lifecycle test');\n", { mode: 0o600 });
  c.reader = { helperPath: helper, sdkPath }; c.allowedOrigins = [`http://127.0.0.1:${port}`];
  const live = (route, body, headers = {}) => request(port, route, body, { ...headers, origin: c.allowedOrigins[0] });
  const filename = path.join(dir, "history.json"); fs.writeFileSync(filename, JSON.stringify(c), { mode: 0o600 });
  const child = spawn(process.execPath, [path.resolve(__dirname, "../server.js")], { cwd: dir, env: {
    HOME: dir, PI_HOME: dir, PATH: path.dirname(process.execPath), PI_BIN: process.execPath,
    STEPSEMBLE_TOKEN: "synthetic-history-host-token", STEPSEMBLE_HISTORY_CONFIG: filename,
    STEPSEMBLE_PORT: String(port), STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_SECURE_COOKIE: "0", STEPSEMBLE_ORPHAN_EXIT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let exited = false; const exit = once(child, "exit").then(value => { exited = true; return value; });
  t.after(async () => {
    if (!exited) {
      child.kill("SIGTERM"); let timer;
      await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]).finally(() => clearTimeout(timer));
      if (!exited) { child.kill("SIGKILL"); await exit; }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    let output = ""; const timer = setTimeout(() => reject(new Error("isolated Host startup timed out")), 8000);
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-8192); if (output.includes("listening on")) { clearTimeout(timer); resolve(); } });
    child.stderr.resume(); child.once("exit", () => { clearTimeout(timer); reject(new Error("isolated Host exited before listening")); });
  });
  const login = await live("/api/login", { token: "synthetic-history-host-token" }, { cookie: "" });
  assert.equal(login.status, 204); const cookie = login.headers.get("set-cookie").split(";")[0];
  for (const alias of ["pi_harbor", "pi_web"]) assert.ok(login.headers.getSetCookie().some(value => value.startsWith(`${alias}=`) && value.includes("Max-Age=0")));
  assert.equal(cookie, `stepsemble=${createHash("sha256").update("synthetic-history-host-token").digest("hex")}`);
  const reg = () => live("/api/history/registrations", registration("one"), { cookie });
  const first = (await reg()).data; assert.equal(first.kind, "history_registration");
  assert.equal((await live("/api/login", { token: "wrong" }, { cookie })).status, 401);
  assert.equal((await reg()).data.generation, first.generation, "failed login keeps the current binding");
  assert.equal((await live("/api/login", { token: "synthetic-history-host-token" }, { cookie })).status, 204);
  assert.equal((await live("/api/history/page", page(first), { cookie })).data.code, "history_binding_unavailable");
  const second = (await reg()).data;
  assert.equal((await live("/api/logout", {}, { cookie: cookie.replace("stepsemble=", "pi_web=") })).status, 204);
  assert.equal((await live("/api/history/page", page(second), { cookie })).data.code, "history_binding_unavailable");
  const document = await fetch(`http://127.0.0.1:${port}/history.html`, { headers: { cookie } });
  assert.equal(document.status, 200); assert.match(await document.text(), /data-history-host/);
  const malformed = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "http://[", method: "GET" }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.end();
  });
  assert.equal(malformed, 400); assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
  assert.equal((await live("/r/not-paired/api/history/catalog", {}, { cookie })).status, 503);
  const current = (await reg()).data;
  const pending = live("/api/history/page", page(current), { cookie }).catch(() => ({ status: 0 }));
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(marker), true, "owned helper reached actual process execution");
  const helperPid = Number(fs.readFileSync(marker, "utf8")); assert.ok(Number.isSafeInteger(helperPid) && helperPid > 0);
  child.kill("SIGTERM"); assert.deepEqual(await exit, [0, null]);
  assert.notEqual((await pending).status, 200);
  assert.throws(() => process.kill(helperPid, 0), error => error.code === "ESRCH", "read-only probe: the owned helper was reaped before Host exit");
});
