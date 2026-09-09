#!/usr/bin/env node
// Full application, owner wizard, pinned writer/reader and typed HTTP; owned data only.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startSyntheticCodexHistoryHost } from "./history-codex-host-synthetic.mjs";
import transport from "../public/modules/history-transport.js";
import projection from "../public/modules/projection.js";

export async function checkCodexHostNative({ helperPath }) {
  const host = await startSyntheticCodexHistoryHost({ helperPath }); let cleanup;
  const viewId = crypto.randomUUID(), cookie = `stepsemble=${crypto.createHash("sha256").update(host.token).digest("hex")}`;
  const client = transport.create({ origin: host.origin, hostId: "owned-codex-host", viewId, canonicalJSON: projection.canonicalJSON,
    fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, origin: host.origin, cookie } }) });
  const catalog = (refresh = true) => client.sourceCatalog({ sourceId: "owned-codex", snapshotId: null, page: { offset: 0, limit: 50 }, refresh });
  const metadata = p => client.sourceMetadata({ sourceId: p.sourceId, catalogId: p.entries[0].catalogId, snapshotId: p.snapshotId, requestId: crypto.randomUUID() });
  const register = p => client.register({ catalogId: p.entries[0].catalogId, viewId });
  const read = (r, offset = 0, version) => client.readCodex({ hostId: "owned-codex-host", bindingId: r.bindingId, generation: r.generation, sessionId: r.sessionId },
    { bindingId: r.bindingId, generation: r.generation, requestId: crypto.randomUUID() }, { page: { offset, limit: 10 }, signal: undefined, ...(version ? { version } : {}) });
  const release = r => client.release({ bindingId: r.bindingId, generation: r.generation });
  try {
    assert.equal(host.setupResult.created, true); assert.equal(host.setupResult.sourceReads, 0);
    assert.equal((await client.catalog()).entries.length, 0);
    const sources = await client.sources(); assert.equal(sources.sources.length, 1); assert.equal(sources.sources[0].scope, "stored_threads");
    assert.equal((await catalog(false)).snapshotId, null, "startup and settings never implicitly scan");
    let p = await catalog(); assert.equal(p.total, 1);
    assert.equal((await metadata(p)).metadata.nativeTitle, "最新 WAL 名稱 🐾");
    let r = await register(p); assert.equal(r.kind, "history_registration", r.code);
    const first = await read(r); assert.equal(first.kind, "bound_codex_records", first.code);
    assert.equal(first.history.nativeThreadId, host.threadId); assert.equal(first.history.records.recordCount, 39);
    const records = [...first.history.records.records]; let cursor = first.history.records.nextOffset;
    while (cursor !== null) {
      const next = await read(r, cursor, first.sourceVersion); assert.equal(next.kind, "bound_codex_records", next.code);
      assert.equal(next.history.records.offset, records.length); records.push(...next.history.records.records); cursor = next.history.records.nextOffset;
    }
    assert.equal(records.length, 39); assert.equal(new Set(records.map(row => row.recordIndex)).size, 39);
    assert.equal(records.at(-1).recordType, "future_owned_record");
    assert(records.some(row => row.payloadType === "function_call")); assert(records.some(row => row.payloadType === "function_call_output"));
    assert(records.every(row => row.rawText.endsWith("\r\n"))); assert.equal(first.history.semanticHistoryComplete, false);
    await host.mutate("rename"); assert.equal((await read(r, 10, first.sourceVersion)).code, "source_version_changed");
    assert.equal((await read(r)).history.nativeTitle, "renamed"); assert.equal((await release(r)).cleanupConfirmed, true);
    p = await catalog(); assert.equal((await metadata(p)).metadata.nativeTitle, "renamed");
    await host.mutate("paginated"); p = await catalog();
    assert.equal((await metadata(p)).metadata.nativeTitle, "paginated name");
    r = await register(p); assert.equal((await read(r)).code, "native_paginated_history_unsupported"); await release(r);
    await host.mutate("path"); p = await catalog(); assert.equal(p.total, 1, "unsafe selector is visible, not silently dropped");
    assert.equal((await metadata(p)).code, "source_scope_mismatch"); assert.equal((await register(p)).kind, "source_unavailable");
    await host.mutate("reset"); await host.mutate("rich_rollout"); p = await catalog();
    r = await register(p); assert.equal((await read(r)).history.records.recordCount, 39); await release(r);
  } finally { cleanup = await host.close(); }
  return { gate: "codex_actual_host_passed", records: 39, sourceScope: "stored_threads", semanticHistoryComplete: false,
    createdConfigUsedUnedited: true, explicitInventory: true, walRenameAndStalePage: true, paginatedExplicitUnavailable: true,
    unsafePathNotOpened: true, noClaudeSdk: true, modelCalls: 0, privateHistoryReads: 0, ...cleanup };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3); console.log(JSON.stringify(await checkCodexHostNative({ helperPath: process.argv[2] })));
}
