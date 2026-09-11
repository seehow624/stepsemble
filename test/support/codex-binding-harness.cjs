"use strict";
const assert = require("node:assert/strict"), { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { createCodexSourceService } = require("../../protocol/native/codex/history-source-service");
const { createReaderAdmission } = require("../../protocol/native/claude/history-reader-admission");
const wire = require("../../protocol/native/codex/parser-wire"), { processJob } = require("../../protocol/native/codex/parser-worker");
const checkpointWire = require("../../protocol/native/codex/checkpoint-wire");
const paginatedResolutionWire = require("../../protocol/native/codex/paginated-resolution-wire");
const f = require("../../protocol/native/codex/parser-fixture.cjs");
const compressedFixture = require("../../protocol/native/codex/compressed-page-parser-fixture.cjs");
const tick = () => new Promise(resolve => setImmediate(resolve)), unavailable = code => ({ kind: "source_unavailable", code });
const source = () => { const v = f.namedRequest(); return { agentId: "codex", sessionId: f.id, history: v.history, sqlite: v.sqlite, historyMode: "legacy" }; };
const group = () => { const v = source(); return { nativeVersion: v.history.nativeVersion, codexRoot: v.history.source.codexRoot,
  expectedCodexRoot: v.history.expectedRoot, sqliteRoot: v.sqlite.source.sqliteRoot, expectedSqliteRoot: v.sqlite.expectedRoot }; };
function harness(t, config = {}) {
  const admission = config.admission ?? createReaderAdmission(), helpers = [], children = [], stages = [];
  let physical = 0, max = 0;
  const add = () => { physical++; max = Math.max(max, physical); }, drop = () => { physical--; assert(physical >= 0); };
  const service = createCodexSourceService({ helperPath: process.execPath, admission, roots: [group()], platform: config.platform ?? "linux",
    deadlineMs: config.deadlineMs ?? 1000, cleanupMs: 20,
    createHelper() {
      const h = { active: false };
      h.status = () => ({ activeWorker: h.active, cleanupConfirmed: !h.active, quarantined: false });
      h.close = () => { if (h.active) { h.active = false; drop(); } };
      for (const method of ["readCodex", "readCodexNameContext", "readCodexValidatedPage", "readCodexStructuredPage",
        "readCodexCompressedPage", "readCodexCompressedStructuredPage"]) h[method] = (input, { signal }) => {
        assert.equal(h.active, false); add(); h.active = true; stages.push(method);
        const compressed = () => {
          const result = compressedFixture.captureFrom(undefined, input.page.offset, input.page.limit,
            { structured: method === "readCodexCompressedStructuredPage" });
          result.rolloutPath = input.source.rolloutPath;
          result.storage.rolloutPath = `${input.source.rolloutPath.replace(/\.zst$/, "")}.zst`;
          return result;
        };
        const promise = new Promise(resolve => { h.finish = (result = method.startsWith("readCodexCompressed") ? compressed()
          : method === "readCodex" ? f.captured()
          : method === "readCodexValidatedPage" ? f.pageCaptured(input.page.offset, input.page.limit) : f.sqliteCapture(), close = true) => { if (close) h.close(); resolve(result); }; });
        signal.addEventListener("abort", () => { if (!config.holdReader) h.finish(unavailable("source_aborted")); }, { once: true });
        config.onRead?.(method, input);
        if (config.auto && !config.holdReader) queueMicrotask(() => h.finish(config.capture?.(method, input)));
        return promise;
      };
      h.readCodexPaginatedCheckpoint = (input, { signal }) => {
        assert.equal(h.active, false); add(); h.active = true; stages.push("readCodexPaginatedCheckpoint");
        const metadata = { observation: { kind: "codex_paginated_projection_checkpoint", nativeVersion: checkpointWire.VERSION,
          sqliteVersion: checkpointWire.SQLITE_VERSION, scope: "provided_history_database_selected_thread_projection_only", threadId: input.source.threadId,
          checkpoint: null, turns: [], itemCount: "0", maxItemOrdinal: null, sourceAuthenticated: false, publishable: false,
          historyComplete: false, connectionClosed: true }, identities: [{ role: "database", device: input.expectedRoot.device, inode: "11" },
          { role: "wal", device: input.expectedRoot.device, inode: "12" }, { role: "shm", device: input.expectedRoot.device, inode: "13" }], filesystemChecksPassed: true,
          sourceDescriptorsClosed: 4, sqliteDescriptorsOpened: 3, sqliteDescriptorsClosed: 3, shmMappingsClosed: 0, requestedReadBytes: 4096,
          readCalls: 2, mappedShmBytes: 0, sourceAuthenticated: false, publishable: false };
        const bytes = Buffer.from(JSON.stringify(metadata));
        const result = { kind: "native_sqlite_paginated_checkpoint", nativeVersion: checkpointWire.VERSION, threadId: input.source.threadId,
          expectedRoot: structuredClone(input.expectedRoot), byteLength: bytes.length, sha256: require("node:crypto").createHash("sha256").update(bytes).digest("hex"),
          sourceAuthenticated: false, publishable: false, metadata, cleanupConfirmed: true };
        const promise = new Promise(resolve => { h.finish = (value = result, close = true) => { if (close) h.close(); resolve(value); }; });
        signal.addEventListener("abort", () => { if (!config.holdReader) h.finish(unavailable("source_aborted")); }, { once: true });
        if (config.auto && !config.holdReader) queueMicrotask(() => h.finish());
        return promise;
      };
      h.readCodexPaginatedResolution = (input, { signal }) => {
        assert.equal(h.active, false); add(); h.active = true; stages.push("readCodexPaginatedResolution");
        const entry = input.entries[0], bytes = Buffer.from(entry.base64Record, "base64");
        const source = { rolloutId: entry.rolloutId, rolloutPath: entry.rolloutPath, compressed: entry.rolloutPath.endsWith(".zst"),
          archived: entry.rolloutPath.startsWith("archived_sessions/"), endOrdinalExclusive: null, endByteOffset: null };
        const plan = { profile: "codex_paginated_chain_plan_v1", threadId: input.threadId, sources: [source], reachedRoot: true,
          chainByteBudget: 256 * 1024 * 1024, chainDecodedByteBudget: 256 * 1024 * 1024, sourceAuthenticated: false, historyComplete: false };
        const result = { kind: "native_codex_paginated_resolution", nativeVersion: paginatedResolutionWire.VERSION, threadId: input.threadId,
          expectedRoot: structuredClone(input.expectedRoot), plan, resolution: { profile: "codex_paginated_resolution_v1", threadId: input.threadId,
            sources: [{ ...source, decodedBytes: String(Math.max(bytes.length, 1)), storedBytes: String(Math.max(bytes.length, 1)), recordCount: 1 }],
            chainStoredBytes: String(Math.max(bytes.length, 1)), chainDecodedBytes: String(Math.max(bytes.length, 1)), ordinalCutoffsVerified: true,
            reachedRoot: true, sourceAuthenticated: false, historyComplete: false }, sourceAuthenticated: false, publishable: false, historyComplete: false,
          cleanupConfirmed: true };
        const promise = new Promise(resolve => { h.finish = (value = result, close = true) => { if (close) h.close(); resolve(value); }; });
        signal.addEventListener("abort", () => { if (!config.holdReader) h.finish(unavailable("source_aborted")); }, { once: true });
        if (config.auto && !config.holdReader) queueMicrotask(() => h.finish(config.paginatedCapture?.(input) ?? result));
        return promise;
      };
      h.shutdown = async () => ({ cleanupConfirmed: !h.active }); helpers.push(h); return h;
    }, spawnChild() {
      add(); stages.push("parser"); const c = new EventEmitter(), input = [];
      c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.active = true; c.kills = 0;
      c.stdin.on("data", b => input.push(b));
      c.close = (code = 0, signal = null) => { if (!c.active) return; c.active = false; drop(); c.emit("close", code, signal); };
      c.kill = () => { c.kills++; if (!config.holdParser) c.close(null, "SIGKILL"); return true; };
      c.reply = (close = true) => { const { job, bytes } = wire.readJob(Buffer.concat(input)); c.stdout.write(wire.encodeResponse(processJob(job, bytes), job)); if (close) c.close(); };
      if (config.auto && !config.holdParser) c.stdin.on("finish", () => queueMicrotask(() => c.reply()));
      children.push(c); return c;
    } });
  const activeHelper = () => helpers.find(h => h.active), activeChild = () => children.find(c => c.active);
  async function step(result, close = true) {
    if (activeHelper()) activeHelper().finish(result, close); else { assert(activeChild()); activeChild().reply(close); }
    await tick();
  }
  t.after(async () => { for (const h of helpers) { h.finish?.(unavailable("source_aborted")); h.close(); } for (const c of children) c.close(); await service.shutdown(); });
  return { service, helpers, children, stages, admission, activeHelper, activeChild, step, physical: () => physical, max: () => max };
}
module.exports = { harness, source, group, f, tick, unavailable };
