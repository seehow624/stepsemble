"use strict";
// Synthetic bytes only. No SQLite connection, private HOME or native account.
const path = require("node:path"), crypto = require("node:crypto");
const wire = require("./sqlite-wire");
const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const request = () => ({ nativeVersion: wire.VERSION, source: { sqliteRoot: path.resolve("owned-sqlite"), threadId: id }, expectedRoot: { device: "1", inode: "2" } });
function createFixture(withContext) {
  const selectedWire = withContext ? wire.context : wire;
  function body() {
    return { observation: { kind: "codex_sqlite_metadata_observation", nativeVersion: wire.VERSION, sqliteVersion: wire.SQLITE_VERSION,
      scope: "provided_connection_selected_name_fields_only", fields: { id, history_mode: "legacy", title: "  原生候選 🐾  ", first_user_message: "first", name: null },
      ...(withContext ? { scope: "provided_connection_selected_name_context_only", nameContext: { rolloutPath: "owned", preview: "" } } : {}),
      nativeTitleResolved: false, sourceAuthenticated: false, publishable: false, connectionClosed: true },
    identities: ["database", "wal", "shm"].map((role, i) => ({ role, device: "1", inode: String(3 + i) })),
    filesystemChecksPassed: true, sourceDescriptorsClosed: 4, sqliteDescriptorsOpened: 3, sqliteDescriptorsClosed: 3,
    shmMappingsClosed: 1, requestedReadBytes: 32768, readCalls: 8, mappedShmBytes: 32768, sourceAuthenticated: false, publishable: false };
  }
  function packet(metadata = body(), payload = Buffer.from(JSON.stringify(metadata))) {
    const r = request();
    return { payload, header: { kind: withContext ? "native_sqlite_name_context" : "native_sqlite_metadata", nativeVersion: r.nativeVersion, threadId: id, expectedRoot: r.expectedRoot,
      byteLength: payload.length, sha256: crypto.createHash("sha256").update(payload).digest("hex"), sourceAuthenticated: false, publishable: false } };
  }
  function frame(job, p = packet(), change = v => v) {
    const header = Buffer.from(JSON.stringify(change({ protocolVersion: withContext ? 5 : 4, nonce: job.nonce, result: p.header }))), size = Buffer.alloc(4);
    size.writeUInt32BE(header.length); return Buffer.concat([size, header, p.payload]);
  }
  function capture(metadata = body()) { const p = packet(metadata); return selectedWire.decode(p.header, p.payload, request()); }
  return { id, request, body, packet, frame, capture };
}
module.exports = { ...createFixture(false), context: createFixture(true) };
