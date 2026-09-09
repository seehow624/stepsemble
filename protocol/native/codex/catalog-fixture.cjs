"use strict";
// Owned synthetic wire bytes only, not a native catalog or source permission.
const crypto = require("node:crypto"), base = require("./sqlite-fixture.cjs"), wire = require("./sqlite-wire").catalog;
function request() { const r = base.request(); delete r.source.threadId; return r; }
function entry(id = base.id) {
  return { id, rolloutPath: "../inert/never-follow", source: "cli", historyMode: "legacy", archived: false,
    createdAt: "0", updatedAt: "9223372036854775807", createdAtMs: "9007199254740993", updatedAtMs: null };
}
function body(entries = [entry()]) {
  return { ...base.body(), observation: { kind: "codex_sqlite_catalog_observation", nativeVersion: wire.VERSION, sqliteVersion: wire.SQLITE_VERSION,
    scope: "provided_state_database_all_stored_threads", entries, sourceAuthenticated: false, publishable: false, connectionClosed: true } };
}
function packet(metadata = body(), payload = Buffer.from(JSON.stringify(metadata))) {
  return { payload, header: { kind: "native_sqlite_catalog", nativeVersion: wire.VERSION, expectedRoot: request().expectedRoot,
    byteLength: payload.length, sha256: crypto.createHash("sha256").update(payload).digest("hex"), sourceAuthenticated: false, publishable: false } };
}
function frame(job, p = packet(), change = v => v) {
  const header = Buffer.from(JSON.stringify(change({ protocolVersion: 8, nonce: job.nonce, result: p.header }))), size = Buffer.alloc(4);
  size.writeUInt32BE(header.length); return Buffer.concat([size, header, p.payload]);
}
function capture(metadata = body()) { const p = packet(metadata); return wire.decode(p.header, p.payload, request()); }
module.exports = { request, entry, body, packet, frame, capture };
