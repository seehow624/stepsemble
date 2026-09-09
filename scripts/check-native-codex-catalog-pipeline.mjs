// Actual owned writer -> Rust v6 -> shared admission -> Codex source index.
// Not private discovery, Host/Web wiring, or native title/content acceptance.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createCodexSourceIndex } from "../protocol/native/codex/history-source-index.js";

export async function checkCodexCatalogPipeline({ helperPath, admission, createHelper, counters, writer, ready, request, sqlSnapshot, claudeRead, codexRead }) {
  const windows = process.platform === "win32";
  const root = windows ? path.resolve("owned-codex-not-opened") : await fs.realpath(ready.codexRoot);
  const stat = windows ? { dev: 1n, ino: 2n } : await fs.stat(root, { bigint: true });
  const source = { nativeVersion: "0.153.4", codexRoot: root, expectedCodexRoot: { device: String(stat.dev), inode: String(stat.ino) },
    sqliteRoot: windows ? path.resolve("owned-sqlite-not-opened") : request.source.sqliteRoot, expectedSqliteRoot: windows ? { device: "1", inode: "3" } : request.expectedRoot };
  const captures = [], beforeAttempts = counters().attempts;
  const index = createCodexSourceIndex({ sourceId: "owned-codex-catalog", source, helperPath, admission, authorize: p => p === "owner",
    createHelper: options => {
      const helper = createHelper(options);
      return { ...helper, readCodexCatalog: async (...args) => {
        const reply = await helper.readCodexCatalog(...args);
        if (reply.kind === "native_sqlite_catalog") {
          assert.equal(helper.status().cleanupConfirmed, true);
          captures.push({ entries: reply.metadata.observation.entries.length, readCalls: reply.metadata.readCalls,
            readBytes: reply.metadata.requestedReadBytes, mappings: reply.metadata.shmMappingsClosed });
        }
        return reply;
      } };
    } });
  try {
    if (windows) {
      assert.equal((await index.refresh("owner")).code, "source_platform_unsupported"); assert.equal(counters().attempts, beforeAttempts);
      return { gate: "node_source_platform_unsupported", readerSpawns: 0, cleanupConfirmed: true };
    }
    const before = await sqlSnapshot(), reading = index.refresh("owner"), peer = claudeRead();
    assert.equal(admission.status().activeWorkers, 2); assert.equal(counters().physical, 2);
    const busyBefore = counters().attempts; assert.equal((await codexRead()).code, "source_busy"); assert.equal(counters().attempts, busyBefore);
    const [initial, nativePeer] = await Promise.all([reading, peer]);
    assert.equal(initial.kind, "source_inventory_state", initial.code); assert.equal(nativePeer.kind, "bound_history_observation", nativePeer.code);
    assert.equal(initial.snapshot.entries.length, 1); const original = initial.snapshot.entries[0];
    assert.equal(original.source.sessionId, ready.threadId); assert.equal(original.source.history.source.rolloutPath, ready.rolloutPath);
    assert.equal(index.lookup("intruder", original.catalogId), null); assert.deepEqual(await sqlSnapshot(), before);
    await writer.command("path"); const changed = await index.refresh("owner");
    assert.equal(changed.kind, "source_inventory_state", changed.code); assert.equal(changed.snapshot.entries[0].catalogId, original.catalogId);
    assert.equal(changed.snapshot.entries[0].unavailable, "source_scope_mismatch");
    assert.equal(index.matchesSelection("owner", original.catalogId, original.revision), false);
    await writer.command("reset"); await writer.command("catalog_full");
    const fullBefore = await sqlSnapshot(), samples = [];
    for (let n = 0; n < 2; n++) {
      let last = performance.now(), maxGapMs = 0;
      const timer = setInterval(() => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - last); last = now; }, 2);
      try {
        const started = performance.now(), full = await index.refresh("owner");
        const elapsedMs = performance.now() - started;
        maxGapMs = Math.max(maxGapMs, performance.now() - last);
        assert.equal(full.kind, "source_inventory_state", full.code); assert.equal(full.snapshot.entries.length, 2048);
        samples.push({ elapsedMs, maxGapMs });
      } finally { clearInterval(timer); }
    }
    assert.deepEqual(await sqlSnapshot(), fullBefore);
    const ids = new Set(); let offset = 0, snapshotId = null, pages = 0;
    do {
      const page = index.page("owner", { offset, limit: 50, snapshotId });
      assert.equal(page.kind, "history_source_catalog"); assert.equal(page.total, 2048); assert(!JSON.stringify(page).includes(root));
      page.entries.forEach(e => { assert(!ids.has(e.catalogId)); ids.add(e.catalogId); });
      offset = page.nextOffset; snapshotId = page.snapshotId; pages++;
    } while (offset !== null);
    assert.equal(ids.size, 2048); assert.equal(pages, 41);
    await writer.command("catalog_extra"); const overflowBefore = await sqlSnapshot();
    assert.equal((await index.refresh("owner")).code, "source_too_large");
    assert.equal(index.metadata("owner").total, 2048); assert.equal(index.metadata("owner").stale, true);
    assert.deepEqual(await sqlSnapshot(), overflowBefore);
    await writer.command("catalog_reset"); const compact = await index.refresh("owner"); assert.equal(compact.snapshot.entries.length, 1);
    const controller = new AbortController(), pending = index.refresh("owner", { signal: controller.signal }); controller.abort();
    assert.equal((await pending).code, "source_aborted"); assert.equal(counters().physical, 0);
    assert.equal(admission.status().quarantined, false); assert.equal(admission.status().cleanupConfirmed, true);
    assert(captures.length >= 5 && captures.every(c => c.mappings > 0));
    return { gate: "posix_owned_catalog_index_passed", readerSpawns: counters().attempts - beforeAttempts, successfulCaptures: captures.length,
      capacityRows: 2048, boundedPages: 41, capacitySamples: samples, maximumReadBytes: Math.max(...captures.map(c => c.readBytes)),
      maximumReadCalls: Math.max(...captures.map(c => c.readCalls)), actualShmEveryCapture: true, changedRolloutInvalidatesBinding: true,
      overflowRetainsStaleSnapshot: true, crossHarnessSharedAdmission: true, maximumPhysicalReaders: counters().maximum, remainingReaders: counters().physical,
      cleanupConfirmed: true, exactSourceBytesPreserved: true, privateHistoryReads: 0, modelCalls: 0, hostWebConnected: false };
  } finally { assert.equal((await index.shutdown()).cleanupConfirmed, true); }
}
