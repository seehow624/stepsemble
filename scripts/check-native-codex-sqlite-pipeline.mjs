// Owned pinned writer -> actual Rust v4 -> Node name observation. The writer is
// an independent test peer, not part of the two-reader subprocess budget.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createCodexMetadataPipeline, createCodexNameContextPipeline } from "../protocol/native/codex/metadata-pipeline.js";
import { createCodexHistoryPipeline } from "../protocol/native/codex/history-pipeline.js";
import parserFixture from "../protocol/native/codex/parser-fixture.cjs";
import { checkCodexNamedPipeline } from "./check-native-codex-named-pipeline.mjs";
import { checkCodexCatalogPipeline } from "./check-native-codex-catalog-pipeline.mjs";

export async function startOwnedSqliteWriter(helperPath) {
  const executable = path.join(path.dirname(helperPath), "examples", `owned_sqlite_writer${process.platform === "win32" ? ".exe" : ""}`);
  assert((await fs.stat(executable)).isFile(), "build the locked test-only writer example first");
  const child = spawn(executable, [], { cwd: path.dirname(executable), env: { LANG: "C", LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe"], shell: false, detached: false });
  let buffer = Buffer.alloc(0), outputBytes = 0, diagnostic = false, closed = false, fault = null, waiter = null;
  const queue = [], fail = () => { fault = new Error("owned_sqlite_writer_protocol"); if (waiter) { waiter.reject(fault); waiter = null; } child.kill("SIGKILL"); };
  const ended = new Promise(resolve => child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); if (waiter) fail(); }));
  child.on("error", fail); child.stdin.on("error", fail); child.stdout.on("error", fail); child.stderr.on("error", fail);
  child.stderr.on("data", () => { diagnostic = true; fail(); });
  child.stdout.on("data", chunk => {
    if ((outputBytes += chunk.length) > 16 * 1024) return fail();
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.includes(10)) {
      const n = buffer.indexOf(10); let value;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, n))); } catch { return fail(); }
      buffer = buffer.subarray(n + 1);
      if (waiter) { const w = waiter; waiter = null; w.resolve(value); } else queue.push(value);
    }
  });
  async function line() {
    if (fault) throw fault; if (queue.length) return queue.shift(); assert(!closed && !waiter);
    let timer;
    try { return await new Promise((resolve, reject) => { waiter = { resolve, reject }; timer = setTimeout(fail, 5000); }); }
    finally { clearTimeout(timer); }
  }
  async function stop() {
    if (!closed && !fault) child.stdin.end("finish\n");
    let timer;
    try {
      const outcome = await Promise.race([ended, new Promise(resolve => { timer = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, 5000); })]);
      assert(outcome, "owned writer cleanup unknown; preserve its reported temporary directory");
      assert.equal(diagnostic, false); assert.equal(fault, null); assert.equal(outcome.code, 0); assert.equal(outcome.signal, null);
      assert.deepEqual(await line(), { kind: "owned_writer_closed", removedOwnedDirectories: 1 }); assert.equal(buffer.length, 0); assert.equal(queue.length, 0);
    } finally { clearTimeout(timer); }
  }
  // Install the cleanup handle before waiting for the first message.
  return { line, stop, command: async command => { assert(["other", "rename", "preview", "path", "paginated", "missing", "reset", "index", "rollout", "fallback", "catalog_full", "catalog_extra", "catalog_reset", "rich_rollout", "structured_rollout", "cold", "reopen", "partial_sidecar", "remove_partial_sidecar", "compressed_path", "plain_path"].includes(command)); child.stdin.write(`${command}\n`); assert.deepEqual(await line(), { kind: "owned_writer_updated" }); } };
}
export async function snapshotOwnedSqlite(root, { allowStoredLayout = false } = {}) {
  const entries = (await fs.readdir(root)).sort(), output = {};
  const allowed = ["state_5.sqlite", "state_5.sqlite-shm", "state_5.sqlite-wal"];
  if (allowStoredLayout) assert(entries.includes(allowed[0]) && entries.every(name => allowed.includes(name)));
  else assert.deepEqual(entries, allowed);
  // This Node process must stay distinct from the SQLite writer: opening and
  // closing its same-inode files in the writer would release POSIX locks.
  for (const name of entries) {
    const file = path.join(root, name); assert((await fs.stat(file)).size <= 4 * 1024 * 1024);
    const bytes = await fs.readFile(file); output[name] = { size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  }
  return output;
}
const snapshot = snapshotOwnedSqlite;
export async function checkCodexSqlitePipeline({ helperPath, admission, createHelper, spawnChild, claudeRead, codexRead, counters }) {
  const captures = [];
  const options = { helperPath, admission, createHelper: options => {
    const helper = createHelper(options);
    const methods = {};
    for (const method of ["readCodexMetadata", "readCodexNameContext"]) methods[method] = async (...args) => {
      const result = await helper[method](...args);
      if (["native_sqlite_metadata", "native_sqlite_name_context"].includes(result.kind)) {
        assert(captures.length < 30); assert.equal(helper.status().cleanupConfirmed, true);
        captures.push({ mappings: result.metadata.shmMappingsClosed, readCalls: result.metadata.readCalls,
          readBytes: result.metadata.requestedReadBytes });
      }
      return result;
    };
    return { ...helper, ...methods };
  } };
  const pipeline = createCodexMetadataPipeline(options), contextPipeline = createCodexNameContextPipeline(options);
  let writer, ready, gate;
  try {
    if (process.platform === "win32") {
      const catalogPipeline = await checkCodexCatalogPipeline({ helperPath, admission, createHelper, counters });
      const before = counters().attempts;
      assert.equal((await pipeline.read({ nativeVersion: "0.153.4", source: { sqliteRoot: path.resolve("owned-not-opened"), threadId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, expectedRoot: { device: "1", inode: "2" } })).code, "source_platform_unsupported");
      assert.equal((await contextPipeline.read({ nativeVersion: "0.153.4", source: { sqliteRoot: path.resolve("owned-not-opened"), threadId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, expectedRoot: { device: "1", inode: "2" } })).code, "source_platform_unsupported");
      const named = createCodexHistoryPipeline({ ...options, spawnChild });
      try { assert.equal((await named.readNamed(parserFixture.namedRequest())).code, "source_platform_unsupported"); }
      finally { assert.equal((await named.shutdown()).cleanupConfirmed, true); }
      assert.equal(counters().attempts, before);
      return { gate: "node_source_platform_unsupported", catalogPipeline, namedPipeline: { gate: "node_source_platform_unsupported", readerSpawns: 0, cleanupConfirmed: true }, readerSpawns: 0, writerSpawns: 0, cleanupConfirmed: true };
    }
    writer = await startOwnedSqliteWriter(helperPath); ready = await writer.line(); assert.equal(ready.kind, "owned_writer_ready");
    const root = await fs.realpath(ready.sqliteRoot), stat = await fs.stat(root, { bigint: true });
    const request = { nativeVersion: "0.153.4", source: { sqliteRoot: root, threadId: ready.threadId }, expectedRoot: { device: String(stat.dev), inode: String(stat.ino) } };
    const catalogPipeline = await checkCodexCatalogPipeline({ helperPath, admission, createHelper, counters, writer, ready, request,
      sqlSnapshot: () => snapshot(root), claudeRead, codexRead });
    const namedPipeline = await checkCodexNamedPipeline({ helperPath, admission, createHelper, spawnChild, counters, writer, ready, request,
      sqlSnapshot: () => snapshot(root), claudeRead, codexRead });
    const before = await snapshot(root), attemptsBefore = counters().attempts;
    const first = pipeline.read(request), peer = claudeRead();
    assert.equal(admission.status().activeWorkers, 2); assert.equal(counters().physical, 2);
    const busyBefore = counters().attempts; assert.equal((await codexRead()).code, "source_busy"); assert.equal(counters().attempts, busyBefore);
    const [a, b] = await Promise.all([first, peer]);
    assert.equal(a.kind, "codex_sqlite_name_capture", a.code); assert.equal(b.kind, "bound_history_observation", b.code);
    assert.equal(a.metadata.candidate, "最新 WAL 名稱 🐾"); assert.equal(a.metadata.fields.title, "  最新 WAL 名稱 🐾  ");
    assert.equal(a.metadata.nativeTitleResolved, false); assert.equal(a.publishable, false); assert.equal(counters().physical, 0);
    assert.deepEqual(await snapshot(root), before, "read-only v4 preserves exact DB/WAL/SHM bytes and names");
    const second = pipeline.read(request, { expectedVersion: a.source }), codex = codexRead();
    assert.equal(admission.status().activeWorkers, 2); assert.equal(counters().physical, 2);
    const againBefore = counters().attempts; assert.equal((await claudeRead()).code, "source_busy"); assert.equal(counters().attempts, againBefore);
    const [c, d] = await Promise.all([second, codex]); assert.equal(c.kind, "codex_sqlite_name_capture", c.code); assert.equal(d.kind, "codex_parsed_capture", d.code);
    const contextRead = contextPipeline.read(request), oldRead = pipeline.read(request);
    assert.equal(admission.status().activeWorkers, 2); assert.equal(counters().physical, 2);
    const v5BusyBefore = counters().attempts;
    assert.equal((await claudeRead()).code, "source_busy"); assert.equal((await codexRead()).code, "source_busy");
    assert.equal(counters().attempts, v5BusyBefore);
    const [initialContext, compatible] = await Promise.all([contextRead, oldRead]);
    assert.equal(initialContext.kind, "codex_sqlite_context_capture", initialContext.code);
    assert.deepEqual(initialContext.nameContext, { rolloutPath: path.join(ready.codexRoot, ready.rolloutPath), preview: "" });
    assert.deepEqual(initialContext.metadata, compatible.metadata);
    assert.deepEqual(await snapshot(root), before, "v5 captures additional context without touching DB/WAL/SHM");
    await writer.command("other");
    assert.equal((await pipeline.read(request, { expectedVersion: a.source })).kind, "codex_sqlite_name_capture", "unrelated writes do not invalidate selected fields");
    assert.equal((await contextPipeline.read(request, { expectedVersion: initialContext.source })).kind, "codex_sqlite_context_capture");
    await writer.command("preview");
    assert.equal((await contextPipeline.read(request, { expectedVersion: initialContext.source })).code, "source_version_changed");
    const previewContext = await contextPipeline.read(request);
    assert.equal(previewContext.nameContext.preview, "  preview 🐾  ");
    assert.equal((await pipeline.read(request, { expectedVersion: a.source })).kind, "codex_sqlite_name_capture", "v4 scope remains five fields");
    await writer.command("path");
    assert.equal((await contextPipeline.read(request, { expectedVersion: previewContext.source })).code, "source_version_changed");
    const inertContext = await contextPipeline.read(request);
    assert.deepEqual(inertContext.nameContext, { rolloutPath: "../never-open/auth.json", preview: "  preview 🐾  " });
    await writer.command("rename"); assert.equal((await pipeline.read(request, { expectedVersion: a.source })).code, "source_version_changed");
    assert.equal((await pipeline.read(request)).metadata.candidate, "renamed");
    await writer.command("paginated"); assert.equal((await pipeline.read(request)).metadata.candidate, "paginated name");
    await writer.command("missing"); const missing = await pipeline.read(request);
    assert.equal(missing.metadata.presence, "missing_row"); assert.equal(missing.metadata.candidate, null);
    const missingContext = await contextPipeline.read(request);
    assert.equal(missingContext.nameContext, null); assert.equal(missingContext.metadata.presence, "missing_row");
    const endBytes = await snapshot(root), wrongRoot = { ...request, expectedRoot: { ...request.expectedRoot, inode: "18446744073709551615" } };
    assert.equal((await pipeline.read(wrongRoot)).code, "source_root_identity_changed");
    assert.equal((await contextPipeline.read(wrongRoot)).code, "source_root_identity_changed");
    const controller = new AbortController(), cancelBefore = counters().attempts, pending = pipeline.read(request, { signal: controller.signal });
    controller.abort(); assert.equal((await pending).code, "source_aborted"); assert.equal(counters().attempts, cancelBefore + 1);
    const contextController = new AbortController(), contextCancelBefore = counters().attempts;
    const contextPending = contextPipeline.read(request, { signal: contextController.signal }); contextController.abort();
    assert.equal((await contextPending).code, "source_aborted"); assert.equal(counters().attempts, contextCancelBefore + 1);
    assert.equal(counters().physical, 0); assert.equal(admission.status().cleanupConfirmed, true); assert.equal(admission.status().quarantined, false);
    assert.deepEqual(await snapshot(root), endBytes, "failed/cancelled captures never repair owned sources");
    assert(captures.length >= 7 && captures.every(c => c.mappings > 0), "active writer requires actual SHM mapping, not orphan WAL recovery");
    gate = { gate: "posix_owned_sqlite_pipeline_passed", namedPipeline, catalogPipeline, platform: process.platform, nodeVersion: process.version, writerSpawns: 1,
      crossHarnessSharedAdmission: true, actualClaudeSdkPeer: true, actualCodexParserPeer: true, maximumPhysicalReaders: counters().maximum,
      remainingReaders: counters().physical, readerSpawns: counters().attempts - attemptsBefore, exactSourceBytesPreserved: true,
      unrelatedWriteVersionStable: true, selectedRenameVersionChanged: true, actualCaptureCancellation: true,
      v5ContextCaptured: true, previewAndPathVersionChanged: true, v4FieldScopePreserved: true, inertPathNotFollowed: true,
      successfulCaptures: captures.length, actualShmMappingEveryCapture: true, maximumReadBytes: Math.max(...captures.map(c => c.readBytes)),
      privateHistoryReads: 0, modelCalls: 0, nativeCodexLaunches: 0, nativeTitleResolved: false, productionWiring: false };
  } finally {
    const cleanup = await pipeline.shutdown(); assert.equal(cleanup.cleanupConfirmed, true, "preserve writer/source if reader cleanup unknown");
    assert.equal((await contextPipeline.shutdown()).cleanupConfirmed, true);
    if (writer) { await writer.stop(); if (ready) assert.equal(await fs.stat(ready.sqliteRoot).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; }), false); }
  }
  return { ...gate, writerReaped: true, removedOwnedDirectories: 1, cleanupConfirmed: true };
}
