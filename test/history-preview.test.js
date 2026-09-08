"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const http = require("node:http"), { once } = require("node:events"), crypto = require("node:crypto");
const { createHistoryIdentity } = require("../server/history-identity");
const { VIEW_HEADER, CSRF_HEADER, LIMITS } = require("../server/history-http");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ownedSdk(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-preview-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const sdk = path.join(root, "sdk.mjs");
  // Deliberately fails the reviewed SDK hash. The child may read this owned
  // file but must never evaluate it, import a native SDK, or make model calls.
  await fs.writeFile(sdk, "throw new Error('SYNTHETIC_SDK_MUST_NOT_EXECUTE');\n", { mode: 0o600 });
  return { root, sdk };
}
function request(origin, target = "/", { method = "GET", body, cookie, headers = {}, viewId = crypto.randomUUID() } = {}) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const hs = { ...(cookie ? { Cookie: cookie } : {}), ...(raw ? { "Content-Type": "application/json", "Content-Length": raw.length,
      Origin: origin, [VIEW_HEADER]: viewId, [CSRF_HEADER]: "1" } : {}), ...headers };
    const req = http.request(new URL(target, origin), { method, headers: hs }, res => {
      const chunks = []; let length = 0;
      res.on("data", bytes => { length += bytes.length; if (length > LIMITS.responseBytes) return res.destroy(new Error("preview_response_limit")); chunks.push(bytes); });
      res.on("error", reject); res.on("end", () => {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        let data; if (res.headers["content-type"]?.startsWith("application/json")) data = JSON.parse(text);
        resolve({ status: res.statusCode, headers: res.headers, text, data });
      });
    }); req.on("error", reject); req.end(raw);
  });
}

test("identity revocation callback failure immediately fans out to every other principal", () => {
  const rows = [1, 2, 3].map(n => ({ id: `synthetic-${n}`, hash: String(n).repeat(64) }));
  const revoked = []; let first;
  const identity = createHistoryIdentity({ browserCredentials: () => rows, peerGrantIds: () => [], authenticatePeerCredential: () => null,
    onRevoke(principal) { revoked.push(principal); if (principal === first) throw new Error("synthetic fan-out failure"); } });
  const principals = rows.map(row => identity.authenticateBrowserCookie("stepsemble", row.hash)); first = principals[0];
  identity.invalidateBrowserCredential(rows[0].id);
  assert.equal(identity.status().failed, true); assert.equal(identity.status().retainedPrincipals, 0);
  assert.deepEqual(new Set(revoked), new Set(principals)); assert.ok(principals.every(p => !identity.isPrincipalCurrent(p)));
  identity.shutdown();
});

test("preview validates SDK target before allocating fixtures; failed listen leaves no owned fixture directory", async t => {
  const { createHistoryPreview } = await import("../scripts/history-preview-server.mjs"), { root, sdk } = await ownedSdk(t);
  await assert.rejects(createHistoryPreview({ sdkPath: path.join(root, "missing", "sdk.mjs") }), /history_preview_configuration_invalid/);
  const directory = path.join(root, "directory", "sdk.mjs"); await fs.mkdir(directory, { recursive: true });
  await assert.rejects(createHistoryPreview({ sdkPath: directory }), /history_preview_configuration_invalid/);
  if (process.platform !== "win32") {
    // Windows file symlinks require a separate privilege; do not request it or
    // turn this POSIX canary into a claim about Windows reparse-point support.
    const target = path.join(root, "wrong-name.mjs"), alias = path.join(root, "alias", "sdk.mjs");
    await fs.writeFile(target, "export {};\n"); await fs.mkdir(path.dirname(alias)); await fs.symlink(target, alias);
    await assert.rejects(createHistoryPreview({ sdkPath: alias }), /history_preview_configuration_invalid/);
  } else t.diagnostic("POSIX symlink target canary not exercised on Windows");
  const names = async () => new Set((await fs.readdir(os.tmpdir())).filter(name => name.startsWith("stepsemble-history-preview-")));
  const before = await names();
  const occupied = http.createServer(); occupied.listen(0, "127.0.0.1"); await once(occupied, "listening");
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  await assert.rejects(createHistoryPreview({ sdkPath: sdk, port: occupied.address().port }), /history_preview_unavailable/);
  const after = await names(); assert.deepEqual([...after].filter(name => !before.has(name)), []);
});

test("isolated preview origin bootstrap, bounded catalog, revoke and actual worker cleanup remain synthetic", async t => {
  const { createHistoryPreview } = await import("../scripts/history-preview-server.mjs"), { sdk } = await ownedSdk(t);
  const preview = await createHistoryPreview({ sdkPath: sdk }); t.after(() => preview.close());
  assert.equal(preview.backend, "legacy_source_worker"); assert.equal(preview.status().backend, "legacy_source_worker");
  const origin = preview.origin;
  for (const headers of [{ Host: "attacker.invalid" }, { Origin: "https://attacker.invalid" }, { "sec-fetch-site": "cross-site" }]) {
    const result = await request(origin, "/", { headers }); assert.equal(result.status, 403); assert.equal(result.headers["set-cookie"], undefined);
  }
  const bootstrap = await request(origin); assert.equal(bootstrap.status, 200);
  const setCookie = bootstrap.headers["set-cookie"][0], cookie = setCookie.split(";")[0];
  assert.match(setCookie, /^stepsemble=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/$/);
  assert.ok(!bootstrap.text.includes(sdk));
  assert.equal((await request(origin, "/api/session?file=private")).status, 404);
  assert.equal((await request(origin, "/api/login", { method: "POST", body: { token: "private" }, cookie })).status, 404);
  assert.equal((await request(origin, "/modules/history-view.js")).headers["set-cookie"], undefined);
  const viewId = crypto.randomUUID(), post = (target, body, credentials = cookie) => request(origin, target, { method: "POST", body, cookie: credentials, viewId });
  const catalog = await post("/api/history/catalog", {}); assert.equal(catalog.status, 200);
  assert.equal(catalog.data.kind, "history_catalog"); assert.equal(catalog.data.sourceAuthenticated, false); assert.equal(catalog.data.publishable, false);
  assert.equal(catalog.data.entries.length, 4);
  for (const entry of catalog.data.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ["catalogId", "description", "label"]); assert.match(entry.catalogId, /^fixture-/);
    assert.ok(entry.label.length <= 120 && entry.description.length <= 300);
  }
  assert.ok(!catalog.text.includes(sdk) && !catalog.text.includes("projectsRoot") && !catalog.text.includes(cookie.slice(11)));
  const registration = await post("/api/history/registrations", { catalogId: "fixture-rich", viewId }); assert.equal(registration.status, 200);
  const binding = registration.data;
  const page = { bindingId: binding.bindingId, generation: binding.generation, requestId: crypto.randomUUID(), page: { offset: 0, limit: 2 } };
  const observed = await post("/api/history/page", page);
  assert.equal(observed.status, 409); assert.equal(observed.data.code, process.platform === "win32" ? "source_platform_unsupported" : "source_sdk_unavailable");
  assert.ok(!observed.text.includes("SYNTHETIC_SDK_MUST_NOT_EXECUTE")); assert.equal(preview.status().workers.activeWorkers, 0);
  if (process.platform !== "win32") {
    const pending = post("/api/history/page", { ...page, requestId: crypto.randomUUID() });
    for (let i = 0; i < 100 && preview.status().workers.activeWorkers === 0; i++) await delay(2);
    assert.equal(preview.status().workers.activeWorkers, 1); preview.revoke();
    assert.notEqual((await pending).status, 200);
    for (let i = 0; i < 100 && preview.status().workers.activeWorkers; i++) await delay(2);
    assert.equal(preview.status().workers.activeWorkers, 0);
  } else preview.revoke();
  assert.equal((await post("/api/history/catalog", {})).status, 401);
  assert.equal((await post("/api/history/registrations", { catalogId: "fixture-rich", viewId })).status, 401);
  const renewed = await request(origin), newCookie = renewed.headers["set-cookie"][0].split(";")[0]; assert.notEqual(newCookie, cookie);
  assert.equal((await post("/api/history/catalog", {}, newCookie)).status, 200);
  assert.equal((await post("/api/history/page", page, newCookie)).data.code, "history_binding_unavailable");
  // Enqueue owned writes, then close immediately. Verification waits for the
  // writes to update their expected bytes; no worker acknowledgement is faked.
  const changes = Array.from({ length: 20 }, () => preview.changeFixture("rich"));
  const close = preview.close(); await Promise.all(changes); await close; await preview.close();
  assert.equal(preview.status().workers.activeWorkers, 0); assert.equal(preview.status().workers.closed, true);
  assert.equal(preview.status().registry.closingSlots, 0); assert.equal(preview.status().registry.closed, true);
  await assert.rejects(preview.changeFixture("rich"), /preview_fixture_unavailable/);
  assert.equal(preview.revoke(), false);
  await assert.rejects(request(origin), error => error.code === "ECONNREFUSED" || error.code === "ECONNRESET");
});

test("preview CLI selects native mode only through one explicit trusted flag", async () => {
  const { parseHistoryPreviewArgs } = await import("../scripts/history-preview-server.mjs");
  const sdk = path.resolve("owned-sdk/sdk.mjs"), helper = path.resolve("owned-bin/helper");
  assert.deepEqual(parseHistoryPreviewArgs([sdk]), { sdkPath: sdk });
  assert.deepEqual(parseHistoryPreviewArgs([sdk, `--native-helper=${helper}`]), { sdkPath: sdk, nativeHelperPath: helper });
  for (const args of [[], [sdk, "--native-helper="], [sdk, "--source=/private"], [sdk, helper],
    [sdk, `--native-helper=${helper}`, `--native-helper=${helper}`], [sdk, undefined]])
    assert.throws(() => parseHistoryPreviewArgs(args), /Usage:/);
});

test("native preview validates trusted executable before fixtures and never falls back on invalid configuration", async t => {
  const { createHistoryPreview } = await import("../scripts/history-preview-server.mjs"), { root, sdk } = await ownedSdk(t);
  const names = async () => new Set((await fs.readdir(os.tmpdir())).filter(name => name.startsWith("stepsemble-history-preview-")));
  const before = await names();
  for (const helper of ["", "relative-helper", `${root}\nhelper`, path.join(root, "helper") + "*"])
    await assert.rejects(createHistoryPreview({ sdkPath: sdk, nativeHelperPath: helper }), /history_preview_configuration_invalid/);
  if (process.platform === "win32") {
    await assert.rejects(createHistoryPreview({ sdkPath: sdk, nativeHelperPath: await fs.realpath(process.execPath) }), /history_preview_native_platform_unsupported/);
  } else {
    const canonicalRoot = await fs.realpath(root), helper = path.join(canonicalRoot, "helper"), directory = path.join(canonicalRoot, "directory");
    await assert.rejects(createHistoryPreview({ sdkPath: sdk, nativeHelperPath: helper }), /history_preview_configuration_invalid/);
    await fs.mkdir(directory);
    await assert.rejects(createHistoryPreview({ sdkPath: sdk, nativeHelperPath: directory }), /history_preview_configuration_invalid/);
    await fs.writeFile(helper, "owned fixture, not executable\n", { mode: 0o600 });
    await assert.rejects(createHistoryPreview({ sdkPath: sdk, nativeHelperPath: helper }), /history_preview_configuration_invalid/);
    await fs.chmod(helper, 0o700);
    const alias = path.join(canonicalRoot, "helper-alias"); await fs.symlink(helper, alias);
    await assert.rejects(createHistoryPreview({ sdkPath: sdk, nativeHelperPath: alias }), /history_preview_configuration_invalid/);
  }
  const after = await names(); assert.deepEqual([...after].filter(name => !before.has(name)), []);
});

test("native preview uses only its own synthetic root identity and preserves native failures, cookie revoke and cleanup", async t => {
  const { createHistoryPreview } = await import("../scripts/history-preview-server.mjs"), { root, sdk } = await ownedSdk(t);
  if (process.platform === "win32") {
    await assert.rejects(createHistoryPreview({ sdkPath: sdk, nativeHelperPath: await fs.realpath(process.execPath) }), /history_preview_native_platform_unsupported/);
    return;
  }
  const helper = path.join(await fs.realpath(root), "owned-helper.cjs");
  // An owned executable protocol fixture, NOT a Rust/ACL success substitute.
  // It verifies the authority tuple passed by preview, then intentionally returns
  // a native-only failure. Legacy fallback would instead return sdk_unavailable.
  await fs.writeFile(helper, `#!${await fs.realpath(process.execPath)}
const fs = require('node:fs');
const job = JSON.parse(fs.readFileSync(0, 'utf8'));
const path = require('node:path');
if (job.protocolVersion !== 1 || job.source.projectKey !== '-synthetic-preview'
  || path.basename(job.source.projectsRoot) !== 'projects'
  || !path.basename(path.dirname(job.source.projectsRoot)).startsWith('stepsemble-history-preview-')) process.exit(2);
const stat = fs.statSync(job.source.projectsRoot, {bigint:true});
if (job.expectedRoot.device !== String(stat.dev) || job.expectedRoot.inode !== String(stat.ino)) process.exit(2);
const header = Buffer.from(JSON.stringify({protocolVersion:1,nonce:job.nonce,result:{kind:'source_unavailable',code:'source_acl_unsupported'}}));
const length = Buffer.alloc(4); length.writeUInt32BE(header.length); process.stdout.write(Buffer.concat([length,header]));
`, { mode: 0o700 });
  const preview = await createHistoryPreview({ sdkPath: sdk, nativeHelperPath: helper }); t.after(() => preview.close());
  assert.equal(preview.backend, "native_bytes_worker"); assert.equal(preview.status().backend, "native_bytes_worker");
  const bootstrap = await request(preview.origin), cookie = bootstrap.headers["set-cookie"][0].split(";")[0];
  assert.ok(!bootstrap.text.includes(helper));
  const viewId = crypto.randomUUID(), post = (target, body, credential = cookie) => request(preview.origin, target,
    { method: "POST", body, cookie: credential, viewId });
  const catalog = await post("/api/history/catalog", {}); assert.equal(catalog.data.entries.length, 4);
  assert.ok(!catalog.text.includes(helper) && !catalog.text.includes("projectsRoot"));
  const registration = await post("/api/history/registrations", { catalogId: "fixture-rich", viewId }); assert.equal(registration.status, 200);
  const page = { bindingId: registration.data.bindingId, generation: registration.data.generation, requestId: crypto.randomUUID(), page: { offset: 0, limit: 2 } };
  const observed = await post("/api/history/page", page);
  assert.equal(observed.status, 409); assert.equal(observed.data.code, "source_acl_unsupported");
  assert.equal(preview.status().workers.activeWorkers, 0); assert.equal(preview.status().workers.quarantined, false);
  preview.revoke(); assert.equal((await post("/api/history/catalog", {})).status, 401);
  const renewed = await request(preview.origin), newCookie = renewed.headers["set-cookie"][0].split(";")[0];
  assert.notEqual(newCookie, cookie); assert.equal((await post("/api/history/catalog", {}, newCookie)).status, 200);
  assert.equal((await post("/api/history/page", page, newCookie)).data.code, "history_binding_unavailable");
  await preview.changeFixture("rich"); await preview.close();
  assert.equal(preview.status().workers.closed, true); assert.equal(preview.status().workers.activeWorkers, 0);
  assert.equal(preview.status().registry.closingSlots, 0);
});
