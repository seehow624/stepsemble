"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), crypto = require("node:crypto");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { createNativeSourceService, LIMITS } = require("../protocol/native/claude/history-native-service");
const { createHistoryRegistry } = require("../protocol/native/claude/history-registry");
const { createReaderAdmission } = require("../protocol/native/claude/history-reader-admission");
const { createSourceIndex } = require("../protocol/native/claude/history-source-index");
const wire = require("../protocol/native/claude/history-bytes-wire");
const fixture = require("../protocol/native/claude/history-fixture.cjs");
const { parseHistoryBytes } = require("../protocol/native/claude/history-source");
const { selectHistory } = require("../protocol/native/claude/history-selection");
const { selectMetadata } = require("../protocol/native/claude/history-metadata");
const testCase = fixture.richCases("/synthetic")[0];
const source = { projectsRoot: path.resolve("owned-composite-projects"), projectKey: "-owned", sessionId: testCase.sessionId };
const helperPath = path.resolve("owned-composite-bin/helper"), sdkPath = path.resolve("owned-sdk/sdk.mjs");
const roots = () => [{ projectsRoot: source.projectsRoot, expectedRoot: { device: "1", inode: "2" } }];
const binding = { bindingId: fixture.uuid(701), generation: 1, source };
const request = { bindingId: binding.bindingId, generation: 1, requestId: fixture.uuid(702) };
const page = { offset: 0, limit: 2 }, tick = () => new Promise(done => setImmediate(done));
const unavailable = code => ({ kind: "source_unavailable", code });
function captured() {
  const bytes = Buffer.from(testCase.records.map(row => JSON.stringify(row)).join("\n") + "\n");
  return { kind: "native_source_bytes", sessionId: source.sessionId, byteLength: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"), identity: { device: "1", inode: "3", size: bytes.length, mtimeNs: "4", ctimeNs: "5" },
    checks: { owner: "posix_euid_and_mode", acl: "no_extended_acl", containment: "root_identity_and_openat_nofollow", reads: 2,
      matchingBytes: true, unchangedObservedIdentity: true }, sourceAuthenticated: false, publishable: false, cleanupConfirmed: true, bytes };
}
async function history(job) {
  const parsed = parseHistoryBytes(captured().bytes, source.sessionId);
  const snapshot = { ...job.snapshot, kind: "source_snapshot", records: parsed.records };
  return selectHistory(snapshot, job.history.page, async (sid, options) => {
    await options.sessionStore.load({ projectKey: options.dir.replace(/[^a-zA-Z0-9]/g, "-"), sessionId: sid });
    return fixture.selectedRows(testCase).slice(options.offset, options.offset + options.limit);
  });
}
function harness(options = {}) {
  const { holdHelperClose, holdWorkerClose, allowOtherHelperActive, onHelperRead, onWorkerSpawn, ...serviceOptions } = options;
  const helpers = [], children = [], launches = []; let physical = 0, maxPhysical = 0;
  const allocate = () => { physical++; maxPhysical = Math.max(maxPhysical, physical); };
  const free = () => { physical--; assert.ok(physical >= 0); };
  const service = createNativeSourceService({ helperPath, sdkPath, roots: roots(), platform: "linux", deadlineMs: 1000, cleanupMs: 20,
    ...serviceOptions, createHelper(config) {
      const h = { config, calls: [], active: false, quarantined: false, closed: false };
      h.status = () => ({ closed: h.closed, quarantined: h.quarantined, activeWorker: h.active, cleanupConfirmed: !h.active });
      h.read = (input, { signal }) => {
        assert.equal(h.active, false); h.active = true; allocate();
        let resolve; const promise = new Promise(done => { resolve = done; });
        const call = { input, signal, resolve };
        h.calls.push(call); h.finish = (result = captured(), close = true) => {
          if (close) h.lateClose(); resolve(result);
        };
        h.lateClose = () => { if (h.active) { h.active = false; free(); } };
        signal.addEventListener("abort", () => { if (!options.holdHelperClose) h.finish(unavailable("source_aborted")); }, { once: true });
        options.onHelperRead?.(h); return promise;
      };
      h.shutdown = async () => { h.closed = true; return { cleanupConfirmed: !h.active, quarantined: h.quarantined }; };
      helpers.push(h); return h;
    }, spawnChild(executable, args, settings) {
      if (!allowOtherHelperActive) assert.equal(helpers.some(h => h.active), false);
      assert.ok(physical < 2);
      allocate(); launches.push({ executable, args, settings });
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      const chunks = []; child.stdin.on("data", chunk => chunks.push(chunk));
      child.job = () => wire.readJob(Buffer.concat(chunks)).job;
      child.kills = 0; child.active = true;
      child.close = (code = 0, signal = null) => { if (child.active) { child.active = false; free(); } child.emit("close", code, signal); };
      child.kill = () => { child.kills++; if (!options.holdWorkerClose) child.close(null, "SIGKILL"); return true; };
      child.reply = (result, close = true) => {
        const job = child.job(); child.stdout.write(JSON.stringify({ protocolVersion: job.protocolVersion, nonce: job.nonce, request: job.request, result }) + "\n");
        if (close) child.close();
      };
      children.push(child); options.onWorkerSpawn?.(child); return child;
    } });
  return { service, bound: service.bind(binding), helpers, children, launches, physical: () => physical, maxPhysical: () => maxPhysical };
}
async function start(h, options = {}) {
  const pending = h.bound.observe(request, { page, ...options });
  h.helpers.find(h => h.active).finish(); await tick();
  const child = h.children.at(-1); child.reply(await history(child.job())); return pending;
}
async function titleResult(job) {
  return selectMetadata({ ...job.snapshot, kind: "source_snapshot", records: testCase.records }, async (sid, options) => {
    await options.sessionStore.load({ projectKey: options.dir.replace(/[^a-zA-Z0-9]/g, "-"), sessionId: sid });
    return { sessionId: sid, customTitle: "原生名稱", summary: "separate summary" };
  });
}
test("native metadata uses the same capture/actual-close/version lifecycle and rejects page options", async () => {
  const h = harness();
  assert.equal((await h.bound.metadata(request, { page })).code, "invalid_history_options");
  assert.equal(h.helpers[0].calls.length, 0);
  const pending = h.bound.metadata(request); h.helpers[0].finish(); await tick();
  const child = h.children[0]; assert.equal(child.job().protocolVersion, 3); assert.equal(Object.hasOwn(child.job().history, "page"), false);
  child.reply(await titleResult(child.job()), false);
  assert.equal(h.bound.status().activeWorker, true, "stdout alone is not actual child close");
  child.close(); const result = await pending;
  assert.equal(result.kind, "bound_session_metadata"); assert.equal(result.metadata.nativeTitle, "原生名稱"); assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.source.kind, "native_source_bytes"); assert.equal(Object.hasOwn(result, "history"), false);
  assert.equal((await start(h, { version: result.sourceVersion })).kind, "bound_history_observation", "metadata token refers to the same captured bytes");
  const changed = h.bound.metadata(request, { version: result.sourceVersion }), bytes = captured(); bytes.identity.inode = "9";
  h.helpers[0].finish(bytes); assert.equal((await changed).code, "source_version_changed"); assert.equal(h.children.length, 2);
  await h.service.shutdown();
});
test("metadata and content share two permits; no third operation or hidden metadata queue", async () => {
  const admission = createReaderAdmission(), h = harness({ admission, allowOtherHelperActive: true });
  const id = fixture.uuid(773), second = h.service.bind({ ...binding, bindingId: id }), scan = sharedIndex(admission);
  const title = h.bound.metadata(request), content = second.observe({ ...request, bindingId: id }, { page });
  assert.equal(admission.status().activeWorkers, 2); assert.equal((await scan.index.refresh("owner")).code, "source_busy");
  assert.equal((await h.bound.observe(request, { page })).code, "source_busy");
  h.helpers[0].finish(); await tick(); assert.equal(admission.status().activeWorkers, 2);
  h.children[0].reply(await titleResult(h.children[0].job())); assert.equal((await title).kind, "bound_session_metadata");
  h.helpers[1].finish(); await tick(); h.children[1].reply(await history(h.children[1].job())); await content;
  assert.equal(admission.status().cleanupConfirmed, true); assert.equal(h.maxPhysical(), 2);
  await Promise.all([h.service.shutdown(), scan.index.shutdown()]);
});
test("metadata cancellation and unknown actual-close quarantine the shared service instead of reusing a live worker", async () => {
  const admission = createReaderAdmission(), h = harness({ admission, holdWorkerClose: true }), controller = new AbortController();
  const pending = h.bound.metadata(request, { signal: controller.signal }); h.helpers[0].finish(); await tick(); controller.abort();
  assert.equal((await pending).code, "source_cleanup_unconfirmed"); assert.equal(h.children[0].kills, 1);
  assert.equal(admission.status().quarantined, true); assert.equal((await h.bound.metadata(request)).code, "source_service_quarantined");
  assert.equal(h.children.length, 1); h.children[0].close(null, "SIGKILL");
  assert.equal(admission.status().cleanupConfirmed, true); assert.equal((await h.service.shutdown()).quarantined, true);
});
test("registry metadata claims exact ownership and refuses a completion after credential revocation", async () => {
  const h = harness(); let active = true;
  const registry = createHistoryRegistry({ sourceService: h.service, catalog: [{ catalogId: "owned", source }],
    authorize: p => p === "owner", principalActive: p => p === "owner" && active });
  const receipt = registry.register("owner", { catalogId: "owned", viewId: fixture.uuid(774) });
  const scope = { bindingId: receipt.bindingId, generation: receipt.generation, viewId: receipt.viewId }, metadataRequest = { ...scope, requestId: request.requestId };
  assert.equal((await registry.metadata("stranger", metadataRequest)).code, "history_binding_unavailable");
  assert.equal((await registry.metadata("owner", { ...metadataRequest, page })).code, "invalid_history_request");
  const pending = registry.metadata("owner", metadataRequest);
  assert.equal(registry.cancelRegistration("owner", receipt), false, "metadata irreversibly claims the private receipt");
  h.helpers[0].finish(); await tick(); active = false; registry.revokePrincipal("owner");
  assert.equal((await pending).code, "history_binding_unavailable"); assert.equal(h.children[0].kills, 1);
  assert.equal((await registry.shutdown()).cleanupConfirmed, true);
});

function sharedIndex(admission, sourceId = "group-a") {
  let finish, active = false, closed = false, calls = 0;
  const index = createSourceIndex({ sourceId, source: roots()[0], helperPath, admission, authorize: principal => principal === "owner",
    createHelper: () => ({
      inventory(_source, { signal }) {
        active = true; calls++;
        return new Promise(resolve => {
          finish = (confirmClose = true) => { if (confirmClose) active = false; resolve(unavailable("source_missing")); };
          signal.addEventListener("abort", () => finish(), { once: true });
        });
      },
      status: () => ({ activeWorker: active, cleanupConfirmed: !active, closed, quarantined: false }),
      async shutdown() { closed = true; finish?.(); return { cleanupConfirmed: !active }; }
    }) });
  return { index, calls: () => calls, active: () => active, finish: confirmClose => finish(confirmClose), lateClose: () => { active = false; } };
}

test("one Host admission bounds inventory plus both content stages without an intervening free slot", async () => {
  const admission = createReaderAdmission(), h = harness({ admission }), a = sharedIndex(admission), b = sharedIndex(admission, "group-b");
  const content = h.bound.observe(request, { page }), scan = a.index.refresh("owner");
  assert.equal(admission.status().activeWorkers, 2); assert.equal(h.physical() + Number(a.active()), 2);
  assert.equal((await b.index.refresh("owner")).code, "source_busy"); assert.equal(b.calls(), 0);
  h.helpers[0].finish(); await tick();
  assert.equal(h.children.length, 1); assert.equal(admission.status().activeWorkers, 2);
  assert.equal((await b.index.refresh("owner")).code, "source_busy"); assert.equal(b.calls(), 0);
  h.children[0].reply(await history(h.children[0].job())); assert.equal((await content).kind, "bound_history_observation");
  const next = b.index.refresh("owner"); assert.equal(b.calls(), 1); assert.equal(admission.status().activeWorkers, 2);
  a.finish(); b.finish(); await Promise.all([scan, next]); assert.equal(admission.status().cleanupConfirmed, true);
  await Promise.all([h.service.shutdown(), a.index.shutdown(), b.index.shutdown()]);
});

test("two source-group scans deny content before spawn, and shutting one index leaves the other alive", async () => {
  const admission = createReaderAdmission(), h = harness({ admission }), a = sharedIndex(admission), b = sharedIndex(admission, "group-b");
  const first = a.index.refresh("owner"), second = b.index.refresh("owner");
  assert.equal((await h.bound.observe(request, { page })).code, "source_busy");
  assert.equal(h.helpers.every(h => h.calls.length === 0), true);
  await a.index.shutdown(); assert.equal((await first).kind, "source_unavailable");
  assert.equal(b.active(), true); assert.equal(admission.status().activeWorkers, 1); assert.equal(admission.status().closed, false);
  const content = h.bound.observe(request, { page }); assert.equal(admission.status().activeWorkers, 2);
  h.helpers[0].finish(); await tick(); h.children[0].reply(await history(h.children[0].job())); await content;
  b.finish(); await second; await Promise.all([h.service.shutdown(), b.index.shutdown()]);
});

test("unknown index cleanup stops content and prevents a replacement service from bypassing quarantine", async () => {
  const admission = createReaderAdmission(), h = harness({ admission }), a = sharedIndex(admission);
  const content = h.bound.observe(request, { page }), scan = a.index.refresh("owner");
  h.helpers[0].finish(); await tick(); a.finish(false);
  assert.equal((await scan).code, "source_cleanup_unconfirmed");
  assert.equal((await content).code, "source_service_quarantined"); assert.equal(h.children[0].kills, 1);
  assert.equal(admission.status().quarantined, true);
  // Cancellation may close this synthetic inventory helper; neither a late
  // close nor a new consumer of the same Host budget can reset quarantine.
  a.lateClose(); assert.equal(admission.status().cleanupConfirmed, true);
  const replacement = harness({ admission }); assert.equal(replacement.bound.code, "source_service_quarantined");
  assert.equal(replacement.helpers.every(h => h.calls.length === 0), true);
  await Promise.all([h.service.shutdown(), a.index.shutdown(), replacement.service.shutdown()]);
});

test("unknown content cleanup propagates across the shared budget to inventory, and late close stays quarantined", async () => {
  const admission = createReaderAdmission(), h = harness({ admission, holdHelperClose: true }), a = sharedIndex(admission);
  const content = h.bound.observe(request, { page }), scan = a.index.refresh("owner");
  h.helpers[0].finish(unavailable("source_cleanup_unconfirmed"), false);
  assert.equal((await content).code, "source_cleanup_unconfirmed"); assert.equal((await scan).code, "source_service_quarantined");
  assert.equal(a.active(), false); assert.equal(admission.status().activeWorkers, 1);
  h.helpers[0].lateClose(); assert.equal(admission.status().activeWorkers, 0); assert.equal(admission.status().quarantined, true);
  assert.equal((await a.index.refresh("owner")).code, "source_service_quarantined");
  await Promise.all([h.service.shutdown(), a.index.shutdown()]);
});

test("shared Host close cancels scans and content before any more spawn; forged budgets are rejected", async () => {
  const admission = createReaderAdmission(), h = harness({ admission }), a = sharedIndex(admission);
  const content = h.bound.observe(request, { page }), scan = a.index.refresh("owner");
  admission.close(); await Promise.all([content, scan]);
  assert.equal(admission.status().cleanupConfirmed, true); assert.equal(h.children.length, 0);
  assert.equal((await a.index.refresh("owner")).code, "source_service_closed");
  assert.equal((await h.bound.observe(request, { page })).code, "source_service_closed");
  assert.throws(() => harness({ admission: { ...admission } }), /invalid_native_source_service_options/);
  assert.throws(() => sharedIndex({ ...admission }), /invalid_source_index_options/);
  await Promise.all([h.service.shutdown(), a.index.shutdown()]);
});

test("trusted immutable root grants and mandatory helper/SDK paths reject unknown roots and extra fields", async () => {
  const grant = roots(), h = harness({ roots: grant });
  assert.equal(h.helpers.length, 2); grant[0].expectedRoot.inode = "999"; grant[0].projectsRoot = path.resolve("other-root");
  const pending = h.bound.observe(request, { page }); assert.deepEqual(h.helpers[0].calls[0].input.expectedRoot, { device: "1", inode: "2" });
  h.helpers[0].finish(); await tick(); h.children[0].reply(await history(h.children[0].job())); assert.equal((await pending).kind, "bound_history_observation");
  assert.deepEqual(h.service.bind({ ...binding, bindingId: fixture.uuid(703), source: { ...source, projectsRoot: path.resolve("ungranted") } }), unavailable("invalid_source_binding"));
  assert.deepEqual(h.service.bind({ ...binding, expectedRoot: { device: "1", inode: "2" } }), unavailable("invalid_source_binding"));
  for (const config of [{ helperPath: undefined }, { sdkPath: undefined }, { roots: undefined }, { roots: [...roots(), ...roots()] },
    { roots: [{ ...roots()[0], expectedRoot: { device: "01", inode: "2" } }] }, { roots: Array(257).fill(roots()[0]) }, { env: {} }])
    assert.throws(() => createNativeSourceService({ helperPath, sdkPath, roots: roots(), ...config }), /invalid_/);
  await h.service.shutdown();
});

test("root table iterators, index accessors and inherited configuration cannot widen or execute the fixed grant table", () => {
  let invoked = 0;
  const iterator = roots(); iterator[Symbol.iterator] = function* () { invoked++; yield* roots(); };
  const getter = roots(); Object.defineProperty(getter, "0", { enumerable: true, get() { invoked++; return roots()[0]; } });
  for (const value of [iterator, getter])
    assert.throws(() => createNativeSourceService({ helperPath, sdkPath, roots: value }), /invalid_native_source_roots/);
  const options = Object.create({ helperPath, sdkPath, roots: roots() });
  assert.throws(() => createNativeSourceService(options), /invalid_native_source_service_options/);
  const configGetter = { sdkPath, roots: roots() };
  Object.defineProperty(configGetter, "helperPath", { enumerable: true, get() { invoked++; return helperPath; } });
  assert.throws(() => createNativeSourceService(configGetter), /invalid_native_source_service_options/);
  assert.equal(invoked, 0);
});

test("stage two only starts after helper actual close and has no source subtree or child-spawn grant", async () => {
  const h = harness(), pending = h.bound.observe(request, { page });
  assert.equal(h.children.length, 0); assert.equal(h.physical(), 1);
  h.helpers[0].finish(); await tick(); assert.equal(h.physical(), 1);
  const launch = h.launches[0]; assert.ok(launch.args.includes("--permission"));
  assert.equal(launch.args.some(arg => arg.includes(source.projectsRoot) || arg.startsWith("--allow-child-process")), false);
  assert.equal(launch.settings.shell, false); assert.deepEqual(launch.settings.env, { LANG: "C", LC_ALL: "C" });
  const child = h.children[0], job = child.job();
  assert.equal(JSON.stringify(job).includes(source.projectsRoot), false); assert.equal(Object.hasOwn(job, "source"), false);
  assert.equal(Object.hasOwn(job.snapshot, "bytes"), false); assert.equal(Object.hasOwn(job.snapshot, "cleanupConfirmed"), false);
  child.reply(await history(job), false); child.emit("exit", 0); await tick(); assert.equal(h.bound.status().activeWorker, true);
  child.close(); assert.equal((await pending).cleanupConfirmed, true); assert.equal(h.physical(), 0); assert.equal(h.maxPhysical(), 1);
  await h.service.shutdown();
});

test("two composite flights bound physical workers to two with no third queue across stage transitions", async () => {
  const h = harness({ allowOtherHelperActive: true });
  const secondId = fixture.uuid(704), thirdId = fixture.uuid(705);
  const second = h.service.bind({ ...binding, bindingId: secondId }), third = h.service.bind({ ...binding, bindingId: thirdId });
  const a = h.bound.observe(request, { page }), b = second.observe({ ...request, bindingId: secondId }, { page });
  assert.equal(h.physical(), 2);
  assert.deepEqual(await third.observe({ ...request, bindingId: thirdId }, { page }), unavailable("source_busy"));
  h.helpers[0].finish(); await tick(); assert.equal(h.physical(), 2);
  // Second helper is now closed; allow harness's phase assertion to see no helper.
  h.helpers[1].finish(); await tick();
  for (const child of h.children) child.reply(await history(child.job()));
  await Promise.all([a, b]); assert.equal(h.maxPhysical(), 2); assert.equal(h.helpers.length, 2); assert.equal(h.service.status().activeWorkers, 0);
  await h.service.shutdown();
});

test("cancel, revoke and shutdown after helper resolution prevent the second spawn", async () => {
  for (const mode of ["abort", "revoke", "shutdown"]) {
    const h = harness(), controller = new AbortController(), pending = h.bound.observe(request, { page, signal: controller.signal });
    h.helpers[0].finish();
    if (mode === "abort") controller.abort(); else if (mode === "revoke") h.bound.revoke(); else h.service.shutdown();
    const result = await pending;
    assert.equal(result.code, { abort: "source_aborted", revoke: "source_binding_revoked", shutdown: "source_service_closed" }[mode]);
    assert.equal(h.children.length, 0); assert.equal(h.physical(), 0); await h.service.shutdown();
  }
});

test("one total deadline covers both stages rather than granting the second child another full budget", async () => {
  const h = harness({ deadlineMs: 100, cleanupMs: 100 }), pending = h.bound.observe(request, { page });
  await new Promise(done => setTimeout(done, 60)); h.helpers[0].finish(); await tick();
  assert.equal(h.children.length, 1);
  await new Promise(done => setTimeout(done, 55));
  assert.equal(h.children[0].kills, 1, "outer 100ms deadline, not a new 100ms after the 60ms helper phase");
  assert.deepEqual(await pending, unavailable("source_worker_timeout")); assert.equal(h.children[0].kills, 1);
  assert.equal(h.physical(), 0); await h.service.shutdown();
});

test("quarantine in one slot aborts the other active flight without replacing either helper", async () => {
  const h = harness({ holdHelperClose: true, allowOtherHelperActive: true });
  const otherId = fixture.uuid(760), other = h.service.bind({ ...binding, bindingId: otherId });
  const first = h.bound.observe(request, { page }), second = other.observe({ ...request, bindingId: otherId }, { page });
  h.helpers[1].finish(); await tick(); assert.equal(h.children.length, 1);
  h.helpers[0].finish(unavailable("source_cleanup_unconfirmed"), false);
  assert.equal((await first).code, "source_cleanup_unconfirmed"); assert.equal((await second).code, "source_service_quarantined");
  assert.equal(h.children[0].kills, 1); assert.equal(h.helpers.length, 2); assert.equal(h.physical(), 1);
  h.helpers[0].lateClose(); assert.equal(h.service.status().activeWorkers, 0); assert.equal(h.service.status().quarantined, true);
  await h.service.shutdown();
});

test("synchronous revoke inside second-stage spawn terminates that child before sending bytes", async () => {
  let bound;
  const h = harness({ onWorkerSpawn: () => bound.revoke() }); bound = h.bound;
  const pending = bound.observe(request, { page }); h.helpers[0].finish(); await tick();
  assert.deepEqual(await pending, unavailable("source_binding_revoked"));
  assert.equal(h.children.length, 1); assert.equal(h.children[0].kills, 1); assert.equal(h.children[0].stdin.readableLength, 0);
  assert.equal(h.physical(), 0); await h.service.shutdown();
});

test("version tokens cannot cross bindings or services, and revoked generation cannot regain a token", async () => {
  const h = harness(), otherService = harness(), first = await start(h), secondId = fixture.uuid(761);
  const second = h.service.bind({ ...binding, bindingId: secondId });
  assert.deepEqual(await second.observe({ ...request, bindingId: secondId }, { page, version: first.sourceVersion }), unavailable("source_version_unavailable"));
  assert.deepEqual(await otherService.bound.observe(request, { page, version: first.sourceVersion }), unavailable("source_version_unavailable"));
  assert.equal(otherService.helpers.every(helper => !helper.calls.length), true);
  h.bound.revoke(); const renewed = h.service.bind({ ...binding, generation: 2 });
  assert.deepEqual(await renewed.observe({ ...request, generation: 2 }, { page, version: first.sourceVersion }), unavailable("source_version_unavailable"));
  assert.equal(h.helpers[0].calls.length, 1); await h.service.shutdown(); await otherService.service.shutdown();
});

test("helper unknown close retains its slot and permanently quarantines the service without rebuilding helpers", async () => {
  const h = harness({ holdHelperClose: true }), pending = h.bound.observe(request, { page });
  h.helpers[0].quarantined = true; h.helpers[0].finish(unavailable("source_cleanup_unconfirmed"), false);
  assert.deepEqual(await pending, unavailable("source_cleanup_unconfirmed")); assert.equal(h.service.status().activeWorkers, 1);
  assert.equal(h.bound.status().cleanupConfirmed, false); assert.equal(h.children.length, 0);
  assert.deepEqual(await h.bound.observe(request, { page }), unavailable("source_service_quarantined"));
  h.helpers[0].lateClose(); assert.equal(h.service.status().activeWorkers, 0); assert.equal(h.bound.status().cleanupConfirmed, true);
  assert.equal(h.service.status().quarantined, true); assert.equal(h.helpers.length, 2);
  await h.service.shutdown();
});

test("worker unknown close and late success cannot publish or clear quarantine", async () => {
  const h = harness({ holdWorkerClose: true }), controller = new AbortController();
  const pending = h.bound.observe(request, { page, signal: controller.signal }); h.helpers[0].finish(); await tick();
  const child = h.children[0]; child.reply(await history(child.job()), false); controller.abort();
  assert.deepEqual(await pending, unavailable("source_cleanup_unconfirmed")); assert.equal(h.service.status().activeWorkers, 1);
  child.close(); assert.equal(h.service.status().activeWorkers, 0); assert.equal(h.service.status().quarantined, true);
  assert.equal(child.kills, 1); assert.equal(h.helpers.length, 2); await h.service.shutdown();
});

test("malformed native captures never start SDK worker and source exceptions remain sanitized", async () => {
  for (const mutate of [s => { delete s.checks.acl; }, s => { s.sourceAuthenticated = true; }, s => { s.identity.device = "99"; },
    s => { s.bytes[0] ^= 1; }, s => { s.cleanupConfirmed = false; }, s => { s.extra = true; }]) {
    const h = harness(), pending = h.bound.observe(request, { page }), value = captured(); mutate(value);
    h.helpers[0].finish(value); assert.deepEqual(await pending, unavailable("source_worker_protocol")); assert.equal(h.children.length, 0);
    await h.service.shutdown();
  }
  const h = harness(), pending = h.bound.observe(request, { page }); h.helpers[0].finish(unavailable("/private/raw-error"));
  assert.deepEqual(await pending, unavailable("source_worker_failure")); await h.service.shutdown();
});

test("malformed helper metadata is detached without invoking getters, including failure envelopes", async () => {
  let invoked = 0;
  const top = captured(); Object.defineProperty(top, "kind", { enumerable: true, get() { invoked++; return "native_source_bytes"; } });
  const nested = captured(); Object.defineProperty(nested.identity, "inode", { enumerable: true, get() { invoked++; return "3"; } });
  const failure = unavailable("source_missing"); Object.defineProperty(failure, "code", { enumerable: true, get() { invoked++; return "source_missing"; } });
  for (const value of [top, nested, failure, { ...unavailable("source_missing"), extra: "untrusted" }]) {
    const h = harness(), pending = h.bound.observe(request, { page }); h.helpers[0].finish(value);
    assert.deepEqual(await pending, unavailable("source_worker_protocol")); assert.equal(h.children.length, 0); await h.service.shutdown();
  }
  assert.equal(invoked, 0);
});

test("native profile and source fingerprint cannot downgrade to legacy checks or change in worker output", async () => {
  for (const mutate of [r => { delete r.source.checks.acl; delete r.source.checks.containment; }, r => { r.source.identity.inode = "999"; },
    r => { r.source.sha256 = "f".repeat(64); }, r => { r.source.publishable = true; }]) {
    const h = harness(), pending = h.bound.observe(request, { page }); h.helpers[0].finish(); await tick();
    const child = h.children[0], value = await history(child.job()); mutate(value); child.reply(value);
    assert.deepEqual(await pending, unavailable("source_worker_protocol")); await h.service.shutdown();
  }
});

test("version is detached per binding; failed refresh preserves it and observed source change revokes it before worker spawn", async () => {
  const h = harness(), first = await start(h), token = first.sourceVersion;
  assert.match(token, /^[a-f0-9]{64}$/); first.history.source.identity.inode = "999";
  const pending = h.bound.observe(request, { page, version: token }); h.helpers[0].finish(); await tick();
  const child = h.children.at(-1); assert.equal(child.job().history.expectedVersion.identity.inode, "3"); child.reply(await history(child.job()));
  assert.equal((await pending).sourceVersion, token);
  const failure = h.bound.observe(request, { page }); h.helpers[0].finish(unavailable("source_missing"));
  assert.equal((await failure).code, "source_missing");
  const count = h.children.length, changed = h.bound.observe(request, { page, version: token }), altered = captured(); altered.identity.mtimeNs = "9";
  h.helpers[0].finish(altered); assert.deepEqual(await changed, unavailable("source_version_changed")); assert.equal(h.children.length, count);
  assert.deepEqual(await h.bound.observe(request, { page, version: token }), unavailable("source_version_unavailable"));
  const refreshed = await start(h); assert.notEqual(refreshed.sourceVersion, token); await h.service.shutdown();
});

test("generation tombstones stay bounded at 64 and stale handles cannot reuse newer scope", async () => {
  const h = harness(); h.bound.revoke();
  assert.deepEqual(h.service.bind(binding), unavailable("source_binding_conflict"));
  const replacement = h.service.bind({ ...binding, generation: 2 }); assert.equal(replacement.descriptor.generation, 2);
  assert.deepEqual(await h.bound.observe(request), unavailable("source_binding_revoked"));
  assert.deepEqual(await replacement.observe(request), unavailable("source_binding_mismatch"));
  for (let i = 1; i < LIMITS.bindings; i++) assert.equal(h.service.bind({ ...binding, bindingId: fixture.uuid(800 + i) }).kind, "bound_source");
  assert.equal(h.service.status().retainedBindings, 64);
  assert.deepEqual(h.service.bind({ ...binding, bindingId: fixture.uuid(999) }), unavailable("source_binding_limit"));
  assert.deepEqual(await replacement.capture({}), unavailable("reserved_source_capture_unavailable")); await h.service.shutdown();
});

test("registry lease revoke between stages prevents publication; actual cleanup permits higher generation reuse", async () => {
  const h = harness(); let now = 100;
  const registry = createHistoryRegistry({ sourceService: h.service, catalog: [{ catalogId: "owned", source }], authorize: () => true,
    principalActive: () => true, now: () => now, leaseMs: 10, maxSlots: 1 });
  const viewId = fixture.uuid(750), reg = registry.register("owner", { catalogId: "owned", viewId });
  const pending = registry.observe("owner", { bindingId: reg.bindingId, generation: reg.generation, viewId, requestId: request.requestId, page });
  h.helpers[0].finish(); now += 11; registry.sweep();
  assert.equal((await pending).kind, "source_unavailable"); assert.equal(h.children.length, 0);
  const next = registry.register("owner", { catalogId: "owned", viewId }); assert.equal(next.bindingId, reg.bindingId); assert.ok(next.generation > reg.generation);
  await registry.shutdown(); assert.equal(h.physical(), 0);
});

test("worker errors, stderr and bounded output failure kill only owned child and never leak diagnostics", async () => {
  for (const mode of ["stderr", "oversize", "malformed", "error"]) {
    const h = harness(), pending = h.bound.observe(request, { page }); h.helpers[0].finish(); await tick(); const child = h.children[0];
    if (mode === "stderr") child.stderr.write("/private-diagnostic");
    if (mode === "oversize") child.stdout.write(Buffer.alloc(wire.LIMITS.outputBytes + 1));
    if (mode === "error") child.emit("error", new Error("/private-diagnostic"));
    if (mode === "malformed") { child.stdout.write("{}\n"); child.close(); }
    const reply = await pending; assert.equal(reply.kind, "source_unavailable"); assert.equal(JSON.stringify(reply).includes("private"), false);
    assert.equal(h.physical(), 0); assert.ok(child.kills <= 1); await h.service.shutdown();
  }
});
