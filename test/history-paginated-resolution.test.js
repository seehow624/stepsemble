"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http"), { once } = require("node:events");
const { createHistoryHttpHandler, LIMITS, VIEW_HEADER, CSRF_HEADER } = require("../server/history-http");
const wire = require("../protocol/native/codex/paginated-resolution-wire");

const ORIGIN = "https://history.example:9443", VIEW = "11111111-1111-4111-8111-111111111111";
const BINDING = "22222222-2222-4222-8222-222222222222", REQUEST = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const rolloutPath = `sessions/2026/01/05/rollout-2026-01-05T12-00-00-${SESSION}.jsonl`;
const body = () => ({ bindingId: BINDING, generation: 1, requestId: REQUEST, selectedRolloutId: SESSION,
  entries: [{ rolloutId: SESSION, base64Record: Buffer.from("meta\n").toString("base64"), rolloutPath }] });
function reply(input) {
  const source = { rolloutId: SESSION, rolloutPath, compressed: false, archived: false, endOrdinalExclusive: null, endByteOffset: null };
  const plan = { profile: "codex_paginated_chain_plan_v1", threadId: SESSION, sources: [source], reachedRoot: true,
    chainByteBudget: 256 * 1024 * 1024, chainDecodedByteBudget: 256 * 1024 * 1024, sourceAuthenticated: false, historyComplete: false };
  return { kind: "bound_codex_paginated_resolution", bindingId: input.bindingId, generation: input.generation, requestId: input.requestId,
    selectedRolloutId: SESSION, sourceVersion: { kind: "codex_paginated_resolution_version", nativeVersion: wire.VERSION, threadId: SESSION,
      rootIdentity: { device: "1", inode: "10" }, selectedRolloutId: SESSION, planSha256: "1".repeat(64), resolutionSha256: "2".repeat(64), sourceCount: 1, reachedRoot: true }, plan,
    resolution: { profile: "codex_paginated_resolution_v1", threadId: SESSION, sources: [{ ...source, decodedBytes: "5", storedBytes: "5", recordCount: 1 }],
      chainStoredBytes: "5", chainDecodedBytes: "5", ordinalCutoffsVerified: true, reachedRoot: true, sourceAuthenticated: false, historyComplete: false },
    consistency: "single_codex_paginated_resolution_observation", historyComplete: false, sourceAuthenticated: false, publishable: false, cleanupConfirmed: true };
}
async function fixture(t, resolver = (_principal, input) => reply(input)) {
  const calls = [], registry = { register: (principal, value) => ({ kind: "history_registration", ...value, bindingId: BINDING, generation: 1,
      sessionId: SESSION, expiresAt: Date.now() + 60000, sourceAuthenticated: false, publishable: false }),
    observe: () => ({ kind: "source_unavailable", code: "native_paginated_history_unsupported" }),
    resolvePaginated(principal, input, options) { calls.push({ principal, input, options }); return resolver(principal, input, options); },
    release: () => ({ kind: "history_released", cleanupConfirmed: true }), current: () => true };
  const auth = { authenticateBrowserCookie: (_name, value) => value === "cookie" ? "browser:one" : null,
    authenticatePeerCredential: () => null, isPrincipalCurrent: () => true };
  const handler = createHistoryHttpHandler({ registry, auth, allowedOrigins: [ORIGIN] });
  const server = http.createServer((req, res) => void handler(req, res)); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const headers = { cookie: "stepsemble=cookie", origin: ORIGIN, "content-type": "application/json", [VIEW_HEADER]: VIEW, [CSRF_HEADER]: "1" };
  const request = (value = body(), headersOverride = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: "/api/history/paginated-resolution", method: "POST", headers: { ...headers, ...headersOverride } }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => { const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode, bytes, data: bytes.length ? JSON.parse(bytes) : null }); });
    }); req.on("error", reject); req.end(JSON.stringify(value));
  });
  return { request, calls };
}

test("paginated resolution HTTP route preserves the bound structured observation", async t => {
  const f = await fixture(t), result = await f.request();
  assert.equal(result.status, 200); assert(wire.validBoundResolution(result.data, SESSION, body()));
  assert.deepEqual(f.calls[0].input, { ...body(), viewId: VIEW }); assert.equal(f.calls[0].principal, "browser:one");
});

test("paginated resolution route validates malformed requests and responses", async t => {
  const f = await fixture(t, (_principal, input) => ({ ...reply(input), historyComplete: true }));
  assert.equal((await f.request({ ...body(), selectedRolloutId: "bad" })).status, 400);
  assert.equal((await f.request()).status, 502); assert.equal((await f.request(body(), { "x-stepsemble-history-csrf": "0" })).status, 403);
  assert.equal(f.calls.length, 1);
});

test("paginated resolution gets its own bounded request budget without widening ordinary history bodies", async t => {
  const large = body(); large.entries[0].base64Record = Buffer.alloc(9000, 97).toString("base64");
  const f = await fixture(t), result = await f.request(large);
  assert.equal(result.status, 200); assert(LIMITS.requestBytes < Buffer.byteLength(JSON.stringify(large)));
  assert.equal(LIMITS.paginatedResolutionRequestBytes, wire.LIMITS.inputBytes);
});
