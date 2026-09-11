"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http"), crypto = require("node:crypto"), { once } = require("node:events");
const { createHistoryHttpHandler, LIMITS, VIEW_HEADER, CSRF_HEADER } = require("../server/history-http");
const wire = require("../protocol/native/codex/checkpoint-wire");
const { canonicalJSON } = require("../public/modules/projection");

const ORIGIN = "https://history.example:9443", VIEW = "11111111-1111-4111-8111-111111111111";
const BINDING = "22222222-2222-4222-8222-222222222222", REQUEST = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const body = () => ({ observation: { kind: "codex_paginated_projection_checkpoint", nativeVersion: wire.VERSION, sqliteVersion: wire.SQLITE_VERSION,
  scope: "provided_history_database_selected_thread_projection_only", threadId: SESSION, checkpoint: { nextRolloutByteOffset: "42", nextRolloutOrdinal: "3" }, turns: [],
  itemCount: "0", maxItemOrdinal: null, sourceAuthenticated: false, publishable: false, historyComplete: false, connectionClosed: true },
  identities: [{ role: "database", device: "1", inode: "11" }, { role: "wal", device: "1", inode: "12" }, { role: "shm", device: "1", inode: "13" }],
  filesystemChecksPassed: true, sourceDescriptorsClosed: 4, sqliteDescriptorsOpened: 3, sqliteDescriptorsClosed: 3, shmMappingsClosed: 0,
  requestedReadBytes: 4096, readCalls: 2, mappedShmBytes: 0, sourceAuthenticated: false, publishable: false });
const reply = () => ({ kind: "bound_codex_paginated_checkpoint", bindingId: BINDING, generation: 1, requestId: REQUEST,
  sourceVersion: { kind: "codex_paginated_projection_checkpoint_version", nativeVersion: wire.VERSION, threadId: SESSION, rootIdentity: { device: "1", inode: "10" },
    identities: [{ role: "database", device: "1", inode: "11" }, { role: "wal", device: "1", inode: "12" }, { role: "shm", device: "1", inode: "13" }], checkpointSha256: "0".repeat(64) },
  checkpoint: body().observation, evidence: body(), consistency: "single_history_database_observation", snapshotAtomic: false, historyComplete: false,
  sourceAuthenticated: false, publishable: false, cleanupConfirmed: true });
function validReply() {
  const value = reply(), canonical = canonicalJSON(value.checkpoint, wire.LIMITS.payloadBytes);
  value.sourceVersion.checkpointSha256 = crypto.createHash("sha256").update(canonical).digest("hex");
  return value;
}
async function fixture(t, checkpoint) {
  const calls = [], registry = {
    register: (principal, value) => ({ kind: "history_registration", ...value, bindingId: BINDING, generation: 1, sessionId: SESSION, expiresAt: Date.now() + 60000, sourceAuthenticated: false, publishable: false }),
    observe: () => ({ kind: "source_unavailable", code: "native_paginated_history_unsupported" }),
    checkpoint(principal, value, options) { calls.push({ principal, value, options }); return checkpoint ? checkpoint(principal, value, options) : validReply(); },
    release: () => ({ kind: "history_released", cleanupConfirmed: true }),
    current: () => true,
  };
  const auth = { authenticateBrowserCookie: (_name, value) => value === "cookie" ? "browser:one" : null,
    authenticatePeerCredential: () => null, isPrincipalCurrent: () => true };
  const handler = createHistoryHttpHandler({ registry, auth, allowedOrigins: [ORIGIN] });
  const server = http.createServer((req, res) => void handler(req, res)); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const headers = { cookie: "stepsemble=cookie", origin: ORIGIN, "content-type": "application/json", [VIEW_HEADER]: VIEW, [CSRF_HEADER]: "1" };
  const request = (path = "/api/history/checkpoint", value = { bindingId: BINDING, generation: 1, requestId: REQUEST }, method = "POST") => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path, method, headers }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => { const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode, bytes, data: bytes.length ? JSON.parse(bytes) : null }); });
    }); req.on("error", reject); req.end(JSON.stringify(value));
  });
  return { request, calls };
}

test("Codex checkpoint HTTP route preserves binding, view and inert consistency flags", async t => {
  const f = await fixture(t); const result = await f.request();
  assert.equal(result.status, 200); assert(wire.validBoundCheckpoint(result.data, SESSION, { bindingId: BINDING, generation: 1, requestId: REQUEST }));
  assert.deepEqual(f.calls[0].value, { bindingId: BINDING, generation: 1, requestId: REQUEST, viewId: VIEW });
  assert.equal(f.calls[0].principal, "browser:one"); assert.equal(result.data.sourceAuthenticated, false); assert.equal(result.data.publishable, false);
});

test("Codex checkpoint route fails closed for malformed replies and requests", async t => {
  const f = await fixture(t, () => ({ ...reply(), historyComplete: true }));
  assert.equal((await f.request()).status, 502); assert.equal((await f.request("/api/history/checkpoint?secret=/private")).status, 405);
  assert.equal((await f.request("/api/history/checkpoint", { bindingId: BINDING, generation: 0, requestId: REQUEST })).status, 400);
  assert.equal(f.calls.length, 1); // malformed reply was the only callback reached
});

test("checkpoint route binds the semantic hash and evidence to the same observation", async t => {
  const hashMismatch = await fixture(t, () => { const value = validReply(); value.sourceVersion.checkpointSha256 = "0".repeat(64); return value; });
  assert.equal((await hashMismatch.request()).status, 502);
  const evidenceMismatch = await fixture(t, () => { const value = validReply(); value.evidence.observation.itemCount = "1"; return value; });
  assert.equal((await evidenceMismatch.request()).status, 502);
});

test("checkpoint route is bounded by the same no-store response policy", async t => {
  const f = await fixture(t); const result = await f.request();
  assert.equal(result.status, 200);
  assert(result.bytes.length <= LIMITS.responseBytes);
});
