"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const { createCodexSourceIndex, normalizeGroupSource } = require("../protocol/native/codex/history-source-index");
const { createReaderAdmission } = require("../protocol/native/claude/history-reader-admission");
const wire = require("../protocol/native/codex/sqlite-wire").catalog, fixture = require("../protocol/native/codex/catalog-fixture.cjs");
const root = path.resolve("owned-codex"), sqlite = fixture.request();
const source = () => ({ nativeVersion: "0.153.4", codexRoot: root, expectedCodexRoot: { device: "1", inode: "20" },
  sqliteRoot: sqlite.source.sqliteRoot, expectedSqliteRoot: sqlite.expectedRoot });
const locator = id => `sessions/2026/01/05/rollout-2026-01-05T12-00-00-${id}.jsonl`;
function row(i = 1) {
  const id = `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
  return { ...fixture.entry(id), rolloutPath: path.join(root, locator(id)), updatedAt: "0", createdAtMs: null, updatedAtMs: String(i) };
}
function harness(t, options = {}) {
  let rows = [row()], available = true, pending = null, nextError = null, calls = 0, held = false;
  const admission = options.admission ?? createReaderAdmission(), helpers = [];
  const index = createCodexSourceIndex({ sourceId: "owned-codex", source: source(), helperPath: process.execPath, admission,
    platform: "linux", authorize: p => p === "owner" && available, createHelper() {
      const state = { activeWorker: false, cleanupConfirmed: true, quarantined: false, closed: false }; helpers.push(state);
      return { status: () => ({ ...state }), shutdown: async () => { state.closed = true; return { cleanupConfirmed: state.cleanupConfirmed }; },
        readCodexCatalog: async (_request, { signal }) => {
          calls++; state.activeWorker = true; state.cleanupConfirmed = false;
          if (held) await new Promise(resolve => { pending = resolve; signal.addEventListener("abort", resolve, { once: true }); });
          state.activeWorker = false; state.cleanupConfirmed = true;
          if (signal.aborted) return { kind: "source_unavailable", code: "source_aborted" };
          const error = nextError; nextError = null;
          if (error) return { kind: "source_unavailable", code: error };
          const body = fixture.body(rows), packet = fixture.packet(body);
          return wire.decode(packet.header, packet.payload, sqlite);
        } };
    } });
  t.after(() => index.shutdown());
  return { index, admission, helpers, calls: () => calls, rows: next => { rows = next; }, allowed: v => { available = v; },
    hold: () => { held = true; }, release: () => { held = false; pending?.(); }, error: e => { nextError = e; } };
}
test("Codex catalog requires explicit independent roots and existing Host admission", () => {
  assert.deepEqual(normalizeGroupSource(source()), source());
  assert.equal(normalizeGroupSource({ ...source(), codexRoot: "relative" }), null);
  assert.equal(normalizeGroupSource({ ...source(), expectedCodexRoot: undefined }), null);
  assert.equal(normalizeGroupSource({ ...source(), codexRoot: source().sqliteRoot }), null);
  assert.throws(() => createCodexSourceIndex({ sourceId: "x", source: source(), helperPath: process.execPath, authorize: () => true }), /invalid_codex_source_index/);
});
test("Codex index publishes bounded path-free pages with explicit refresh, preserved IDs and real time ordering", async t => {
  const h = harness(t), rows = Array.from({ length: 51 }, (_, n) => row(n + 1)); h.rows(rows);
  assert.equal(h.calls(), 0); assert.equal(h.index.metadata("owner").total, 0);
  assert.equal(h.index.page("intruder", {}).code, "history_source_unavailable"); assert.equal(h.calls(), 0);
  const first = await h.index.refresh("owner"); assert.equal(first.kind, "source_inventory_state"); assert.equal(first.snapshot.entries.length, 51);
  assert.equal(first.snapshot.entries[0].source.sessionId, row(51).id);
  const page = h.index.page("owner", { offset: 0, limit: 50, snapshotId: null });
  assert.equal(page.entries.length, 50); assert.equal(page.nextOffset, 50); assert.equal(page.stale, false);
  assert(!JSON.stringify(page).includes(root)); assert(!JSON.stringify(page).includes("rollout"));
  assert.deepEqual(Object.keys(page.entries[0]).sort(), ["catalogId", "nativeTitle", "titleStatus"]);
  assert.match(page.entries[0].catalogId, /^codex-[0-9a-f]{64}$/); assert.equal(page.entries[0].nativeTitle, null);
  assert.equal(h.index.page("owner", { offset: 50, limit: 50, snapshotId: page.snapshotId }).entries.length, 1);
  assert.equal(h.index.page("owner", { offset: 50, limit: 50, snapshotId: null }).code, "history_catalog_changed");
  const selected = h.index.lookup("owner", page.entries[0].catalogId);
  assert.equal(selected.source.history.source.rolloutPath, locator(row(51).id));
  assert.equal(selected.source.sqlite.source.threadId, row(51).id); assert.equal(selected.unavailable, null);
  await h.index.refresh("owner"); assert.equal(h.index.lookup("owner", page.entries[0].catalogId).revision, selected.revision);
  assert.equal(h.index.page("owner", { offset: 0, limit: 50, snapshotId: page.snapshotId }).code, "history_catalog_changed");
  assert.equal(h.index.matchesSelection("intruder", page.entries[0].catalogId, selected.revision), false);
});
test("changed current rollout invalidates binding revision without duplicating a native thread", async t => {
  const h = harness(t); const a = await h.index.refresh("owner"), old = a.snapshot.entries[0];
  const changed = row(); changed.rolloutPath = changed.rolloutPath.replace(".jsonl", "_00000000-0000-4000-8000-000000000009.jsonl"); h.rows([changed]);
  const b = await h.index.refresh("owner"); const next = b.snapshot.entries[0];
  assert.equal(next.catalogId, old.catalogId); assert.notEqual(next.revision, old.revision);
  assert.deepEqual(b.snapshot.changes, { added: 0, changed: 1, removed: 0 });
  assert.equal(h.index.matchesSelection("owner", old.catalogId, old.revision), false);
  assert.equal(h.index.matchesSelection("owner", old.catalogId, next.revision), true);
  h.rows([]); const gone = await h.index.refresh("owner"); assert.deepEqual(gone.snapshot.changes, { added: 0, changed: 0, removed: 1 });
  assert.equal(h.index.lookup("owner", old.catalogId), null);
});
test("archived, internal, subagent and unknown rows are retained; unsafe routing never becomes a source handle", async t => {
  const h = harness(t), rows = Array.from({ length: 7 }, (_, n) => row(n + 1));
  rows[0].archived = true; rows[0].rolloutPath = path.join(root, `archived_sessions/rollout-2026-01-05T12-00-00-${rows[0].id}.jsonl`);
  rows[1].source = '{"subagent":"review"}'; rows[2].source = '{"internal":"guardian"}';
  rows[3].source = "unknown-future"; rows[3].rolloutPath = "../never-follow";
  rows[4].rolloutPath = path.join(path.resolve("outside-owned"), locator(rows[4].id));
  rows[5].historyMode = "paginated"; rows[6].rolloutPath += ".zst"; h.rows(rows);
  const state = await h.index.refresh("owner"), entries = state.snapshot.entries.sort((a, b) => a.native.id < b.native.id ? -1 : 1);
  assert.equal(entries.length, 7); assert.equal(entries[0].unavailable, null); assert.equal(entries[1].sourceKind, "subagent");
  assert.equal(entries[2].sourceKind, "internal"); assert.equal(entries[3].sourceKind, "unknown");
  for (const n of [3, 4]) { assert.equal(entries[n].unavailable, "source_scope_mismatch"); assert.equal(entries[n].source.history, null); }
  assert.equal(entries[5].native.historyMode, "paginated"); assert.equal(entries[6].unavailable, null);
  assert.equal(h.index.page("owner", { offset: 0, limit: 50, snapshotId: null }).total, 7);
});
test("catalog failure retains last known rows as stale, and revoke blocks in-flight or later publication", async t => {
  const h = harness(t); const old = await h.index.refresh("owner"); h.error("source_busy");
  assert.equal((await h.index.refresh("owner")).code, "source_busy");
  assert.equal(h.index.metadata("owner").stale, true); assert.equal(h.index.metadata("owner").lastError, "source_busy");
  assert.deepEqual(h.index.view("owner").snapshot, old.snapshot);
  h.hold(); const p = h.index.refresh("owner"); h.allowed(false); h.index.revokePrincipal("owner"); h.release();
  assert.equal((await p).code, "source_aborted"); assert.equal(h.index.lookup("owner", old.snapshot.entries[0].catalogId), null);
  assert.equal(h.index.view("owner").code, "history_source_unavailable"); assert.equal(h.admission.status().activeWorkers, 0);
});
test("Codex source index shares global two-flight budget and closes before discarding its snapshot", async t => {
  const admission = createReaderAdmission(), h = harness(t, { admission }); h.hold();
  const peer = admission.acquire(() => {}, () => true); const p = h.index.refresh("owner");
  assert.equal(admission.status().activeWorkers, 2);
  assert.equal((await h.index.refresh("owner")).code, "source_busy");
  assert.equal(admission.acquire(() => {}, () => true).code, "source_busy"); assert.equal(h.calls(), 1);
  const closing = h.index.shutdown(); h.release(); assert.equal((await p).code, "source_service_closed");
  assert.equal((await closing).cleanupConfirmed, true); assert.equal(h.index.status().retainedEntries, 0);
  peer.finish(); assert.equal(admission.status().activeWorkers, 0);
});
test("batched catalog projection rechecks revocation before publishing and shutdown waits for it", async t => {
  const h = harness(t); const first = await h.index.refresh("owner");
  h.rows(Array.from({ length: 2048 }, (_, n) => row(n + 1)));
  const pending = h.index.refresh("owner");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.index.status().refreshing, true, "index yields while projecting the large captured catalog");
  assert.equal(h.admission.status().activeWorkers, 0, "reader already closed; no extra physical work budget");
  h.index.revokePrincipal("owner");
  assert.equal((await pending).code, "source_aborted");
  assert.deepEqual(h.index.view("owner").snapshot, first.snapshot); assert.equal(h.index.metadata("owner").stale, true);
  const next = h.index.refresh("owner"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.index.status().refreshing, true);
  const closing = h.index.shutdown(); assert.equal((await next).code, "source_service_closed");
  assert.equal((await closing).cleanupConfirmed, true); assert.equal(h.index.status().refreshing, false);
  assert.equal(h.index.status().retainedEntries, 0);
});
