#!/usr/bin/env node
// Native read oracle over trusted owned projection rows. No resume/materialize,
// model, credentials, private source, production grant or schema migration logic.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { withHistorySchemas, verifyHistorySchemas } from "./check-native-codex-history.mjs";
import { probeEnvironment } from "./check-native-codex-schema.mjs";
import { historyRpc } from "../protocol/native/codex/history-rpc.js";
import { paginatedFixture } from "../protocol/native/codex/paginated-history-fixture.js";
import { observePaginatedItems } from "../protocol/native/codex/paginated-history-observation.js";

// Optional owned differential probe. When present it must AGREE with native;
// when absent the oracle still runs and reports that it was skipped.
const ancestryProbe = process.env.STEPSEMBLE_ANCESTRY_PROBE || null;
// Optional owned source-opening probe. It is a separate helper because the
// ancestry probe intentionally never opens paths; when present this helper
// receives only the disposable fixture root and must resolve every planned
// source through the existing Rust POSIX boundary.
const paginatedResolutionProbe = process.env.STEPSEMBLE_PAGINATED_RESOLUTION_PROBE
  || (() => {
    const candidate = path.resolve("crates/history-source-reader/target/debug/stepsemble-history-source-reader");
    return process.platform === "win32" ? `${candidate}.exe` : candidate;
  })();

/** The first complete JSONL record, which is the rollout's session_meta. */
function firstRecord(raw) {
  const end = raw.indexOf(0x0a);
  assert(end > 0, "rollout must start with a complete record");
  return raw.subarray(0, end + 1);
}

function probeAncestry(binary, entries) {
  assert(path.isAbsolute(binary), "absolute owned probe binary required");
  const input = JSON.stringify(entries);
  const result = spawnSync(binary, [], { input, encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024, shell: false });
  assert.equal(result.status, 0, "ancestry probe must exit cleanly");
  const parsed = JSON.parse(result.stdout);
  assert(!parsed.error, `ancestry probe refused a record native accepted: ${parsed.error}`);
  return parsed;
}

function probePaginatedResolution(binary, input) {
  assert(path.isAbsolute(binary), "absolute owned resolution probe binary required");
  const result = spawnSync(binary, [], {
    input: JSON.stringify(input), encoding: null, timeout: 20000, maxBuffer: 256 * 1024,
    shell: false
  });
  assert.equal(result.status, 0, "paginated resolution probe must exit cleanly");
  assert(result.stdout.length >= 4, "paginated resolution probe must return a frame");
  const length = result.stdout.readUInt32BE(0);
  assert.equal(result.stdout.length, 4 + length, "paginated resolution probe frame length");
  return JSON.parse(result.stdout.subarray(4).toString("utf8"));
}

function assertResolutionDifferential(result, expected) {
  assert.equal(result.protocolVersion, 15);
  assert.equal(result.nonce, expected.nonce);
  assert.equal(result.result?.kind, "native_codex_paginated_resolution", result.result?.code);
  const value = result.result;
  assert.equal(value.nativeVersion, expected.nativeVersion);
  assert.equal(value.threadId, expected.threadId);
  assert.deepEqual(value.plan.sources.map(source => source.rolloutId), expected.rolloutIds);
  assert.deepEqual(value.resolution.sources.map(source => source.rolloutId), expected.rolloutIds);
  assert.deepEqual(value.resolution.sources.map(source => source.rolloutPath), expected.rolloutPaths);
  assert.equal(value.plan.reachedRoot, true);
  assert.equal(value.resolution.reachedRoot, true);
  assert.equal(value.sourceAuthenticated, false);
  assert.equal(value.publishable, false);
  assert.equal(value.historyComplete, false);
  assert.equal(value.resolution.sourceAuthenticated, false);
  assert.equal(value.resolution.historyComplete, false);
  assert.deepEqual(value.resolution.sources.map(source => source.storedBytes), expected.storedBytes);
  assert.deepEqual(value.resolution.sources.map(source => source.decodedBytes), expected.decodedBytes);
  assert.deepEqual(value.resolution.sources.map(source => source.recordCount), expected.recordCounts);
  const expectedChainBytes = expected.storedBytes
    .reduce((total, size) => (BigInt(total) + BigInt(size)).toString(), "0");
  assert.equal(value.resolution.chainStoredBytes, expectedChainBytes);
  const expectedDecodedChainBytes = expected.decodedBytes
    .reduce((total, size) => (BigInt(total) + BigInt(size)).toString(), "0");
  assert.equal(value.resolution.chainDecodedBytes, expectedDecodedChainBytes);
  assert.equal(value.resolution.ordinalCutoffsVerified, true);
  const exact = value.resolution.sources.every(source =>
    typeof source.storedBytes === "string" && /^(0|[1-9][0-9]*)$/.test(source.storedBytes)
    && typeof source.decodedBytes === "string" && /^(0|[1-9][0-9]*)$/.test(source.decodedBytes));
  assert(exact, "paginated resolution sizes must remain exact decimal strings");
  return value;
}

export async function checkPaginatedRuntime(binary) {
  assert(path.isAbsolute(binary), "absolute pinned native binary required");
  return withHistorySchemas(binary, async snapshot => {
    await verifyHistorySchemas(snapshot);
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-codex-paginated-owned-")));
    const codexHome = path.join(home, "codex"), sqliteHome = path.join(home, "sqlite"), saved = new Map();
    let client, db, physical = 0, starts = 0, requests = 0, cleanupConfirmed = true;
    const notices = [], sink = createServer((_req, res) => { requests++; res.writeHead(503); res.end(); });
    const save = async (file, bytes) => { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 }); saved.set(file, Buffer.from(bytes)); };
    const start = async () => {
      assert(!db && !client && physical === 0 && cleanupConfirmed, "no fixture/native overlap");
      const child = spawn(await fs.realpath(binary), ["app-server", "--listen", "stdio://"],
        { cwd: home, env: probeEnvironment(home), stdio: ["pipe", "pipe", "pipe"], shell: false });
      physical++; starts++; cleanupConfirmed = false; child.once("close", () => { physical--; });
      client = historyRpc(child, { allowIndexRepair: true, allowOwnedLinuxSandboxNotice: process.platform === "linux" });
      await client.initialize(); assert.deepEqual((await client.request("thread/loaded/list")).data, []);
    };
    const close = async () => {
      if (!client) return;
      notices.push(...client.diagnostics().startupNotices);
      ({ cleanupConfirmed } = await client.close()); assert(cleanupConfirmed && physical === 0); client = null;
    };
    let observedPages = 0;
    const collect = async (method, params, meta) => {
      const rows = [], seen = new Set(); let cursor;
      for (let page = 0; page < 16; page++) {
        const result = await client.request(method, { ...params, limit: 1, ...(cursor ? { cursor } : {}) });
        if (meta) {
          const observation = observePaginatedItems({ nativeVersion: snapshot.nativeVersion, threadId: params.threadId, turnId: params.turnId ?? null, thread: meta, page: result });
          assert.equal(observation.kind, "codex_paginated_items_observation"); assert.equal(observation.nativeTitle, meta.name);
          assert.deepEqual(observation.items.map(row => ({ turnId: row.nativeTurnId, item: row.nativeData })), result.data);
          assert.equal(observation.sourceAuthenticated, false); assert.equal(observation.publishable, false); assert.equal(observation.historyComplete, false); observedPages++;
        }
        rows.push(...result.data);
        if (result.nextCursor === null) return rows;
        assert(result.nextCursor && !seen.has(result.nextCursor), "missing/repeated cursor"); seen.add(result.nextCursor); cursor = result.nextCursor;
      }
      throw new Error("owned_paginated_page_limit");
    };
    const stateFile = path.join(sqliteHome, "state_5.sqlite"), historyFile = path.join(sqliteHome, "thread_history_1.sqlite");
    const root = paginatedFixture({ threadId: crypto.randomUUID(), cwd: home });
    const child = paginatedFixture({ threadId: crypto.randomUUID(), cwd: home, historyBase: root.forkCutoff, suffix: "child" });
    const fixtures = [root, child];
    try {
      await new Promise((resolve, reject) => { sink.once("error", reject); sink.listen(0, "127.0.0.1", () => { sink.removeListener("error", reject); resolve(); }); });
      await fs.mkdir(sqliteHome, { mode: 0o700 });
      await save(path.join(codexHome, "config.toml"), `sqlite_home = ${JSON.stringify(sqliteHome)}\nmodel_provider = "paginated_fixture"\ncli_auth_credentials_store = "file"\nproject_doc_max_bytes = 0\n[model_providers.paginated_fixture]\nname = "Owned paginated fixture"\nbase_url = "http://127.0.0.1:${sink.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\napps = false\nplugins = false\nhooks = false\nshell_snapshot = false\nmemories = false\nshell_tool = false\n[otel]\nexporter = "none"\n`);
      for (const [i, fixture] of fixtures.entries()) {
        fixture.file = path.join(codexHome, "sessions/2026/01/05", `rollout-2026-01-05T12-00-0${i}-${fixture.rolloutId}.jsonl`);
        fixture.name = `原生分頁名稱 ${i} 🐾`;
        await save(fixture.file, fixture.raw);
      }
      await save(path.join(codexHome, "session_index.jsonl"), fixtures.map(f => JSON.stringify({ id: f.threadId, thread_name: "不應使用的舊索引名稱", updated_at: "2026-01-05T12:30:00Z" })).join("\n") + "\n");
      // Native itself creates all DBs/tables/migrations. This first scan is allowed
      // to repair ONLY this owned metadata DB; an empty projection is not success.
      await start();
      await collect("thread/list", { useStateDbOnly: false });
      for (const f of fixtures) {
        assert.equal((await client.request("thread/read", { threadId: f.threadId })).thread.historyMode, "paginated");
        assert.deepEqual(await collect("thread/items/list", { threadId: f.threadId }), []);
      }
      client.assertHealthy(); await close();
      const { DatabaseSync } = await import("node:sqlite");
      const open = (file, readOnly = false) => { assert(!client && physical === 0); db = new DatabaseSync(file, { readOnly, allowExtension: false }); db.exec("PRAGMA trusted_schema=OFF"); return db; };
      const metadataRows = () => db.prepare("SELECT id,name,preview,history_mode,rollout_path FROM threads ORDER BY id").all().map(r => ({ ...r }));
      open(stateFile); db.exec("BEGIN IMMEDIATE");
      for (const f of fixtures) assert.equal(db.prepare("UPDATE threads SET name=?, preview=? WHERE id=? AND history_mode='paginated'").run(f.name, "Fixture preview", f.threadId).changes, 1);
      db.exec("COMMIT"); let expectedMetadata = metadataRows(); db.close(); db = null;
      open(historyFile);
      const schemas = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => ({ ...r, sql: r.sql?.replaceAll("\r\n", "\n") ?? null }));
      assert(schemas.some(r => r.name === "thread_items") && schemas.some(r => r.name === "thread_turns") && schemas.some(r => r.name === "thread_history_projection_state"));
      const historySchemaSha256 = crypto.createHash("sha256").update(JSON.stringify(schemas)).digest("hex");
      assert.equal(historySchemaSha256, "5dc2e78ea370ca336b00f7ed52a845bd89692804fb0a829476eb9e901e57dd90", "pinned native-created history schema drift");
      // The bounded Rust checkpoint reader compiles these exact DDL fixtures in
      // and refuses anything else, so drift must fail here rather than silently
      // changing what a projection checkpoint is allowed to mean.
      for (const [table, file] of [["thread_turns", "sqlite-thread-turns-0.153.4.sql"],
        ["thread_items", "sqlite-thread-items-0.153.4.sql"],
        ["thread_history_projection_state", "sqlite-thread-projection-0.153.4.sql"]]) {
        const pinned = (await fs.readFile(new URL(`../protocol/native/codex/${file}`, import.meta.url), "utf8")).trim();
        assert(!pinned.includes("\r"), "canonical schema fixture must stay LF on every checkout");
        assert.equal(schemas.find(row => row.name === table).sql, pinned, `pinned ${table} DDL drift`);
      }
      const seed = f => {
        for (const t of f.turns) db.prepare("INSERT INTO thread_turns (thread_id,turn_id,rollout_ordinal,status,started_at,completed_at,duration_ms,first_user_item_id,final_agent_item_id,rollout_byte_offset,rollout_end_ordinal,rollout_end_byte_offset) VALUES (?,?,?,'completed',10,20,10000,?,?,?,?,?)")
          .run(f.rolloutId, t.turnId, t.ordinal, t.firstUserItemId, t.finalAgentItemId, t.offset, t.endOrdinal, t.endOffset);
        for (const it of f.items) db.prepare("INSERT INTO thread_items (thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json,item_type,updated_at_ordinal) VALUES (?,?,?,?,?,?,?,?)")
          .run(f.rolloutId, it.turnId, it.itemId, it.createdOrdinal, it.createdAtMs, JSON.stringify(it.item), it.item.type, it.updatedOrdinal);
        db.prepare("INSERT INTO thread_history_projection_state (thread_id,next_rollout_byte_offset,next_rollout_ordinal) VALUES (?,?,?)")
          .run(f.rolloutId, f.checkpoint.nextByteOffset, f.checkpoint.nextOrdinal);
      };
      db.exec("BEGIN IMMEDIATE"); for (const f of fixtures) seed(f);
      db.exec("COMMIT");
      const tables = ["thread_turns", "thread_items", "thread_history_projection_state"];
      const rows = () => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY thread_id${table === "thread_history_projection_state" ? "" : ",rollout_ordinal"}`).all().map(r => ({ ...r })));
      let expectedProjection = rows(); db.close(); db = null;
      await start();
      let itemPages = 0, turnPages = 0;
      for (const f of fixtures) {
        const meta = (await client.request("thread/read", { threadId: f.threadId })).thread;
        assert.equal(meta.name, f.name); assert.equal(meta.status.type, "notLoaded"); assert.deepEqual(meta.turns, []);
        const expected = f === root ? root.items : [...root.items.filter(it => it.createdOrdinal < root.forkCutoff.end_ordinal_exclusive), ...child.items];
        const entries = await collect("thread/items/list", { threadId: f.threadId }, meta);
        assert.deepEqual(entries, expected.map(it => ({ turnId: it.turnId, item: it.item }))); itemPages += entries.length;
        const all = await client.request("thread/items/list", { threadId: f.threadId, limit: 50 });
        assert.deepEqual(all.data, entries); assert.equal(all.nextCursor, null);
        assert.equal(observePaginatedItems({ nativeVersion: snapshot.nativeVersion, threadId: f.threadId, turnId: null, thread: meta, page: all }).kind, "codex_paginated_items_observation");
        const turns = await collect("thread/turns/list", { threadId: f.threadId });
        assert.deepEqual(turns.flatMap(t => t.items.map(item => ({ turnId: t.id, item }))), entries);
        assert(turns.every(t => t.itemsView === "full" && t.status === "completed" && t.startedAt === 10 && t.completedAt === 20 && t.durationMs === 10000)); turnPages += turns.length;
        for (const turn of turns) assert.deepEqual(await collect("thread/items/list", { threadId: f.threadId, turnId: turn.id }, meta), entries.filter(it => it.turnId === turn.id));
      }
      const first = await client.request("thread/items/list", { threadId: root.threadId, limit: 1 });
      assert(first.nextCursor);
      await assert.rejects(client.request("thread/items/list", { threadId: child.threadId, cursor: first.nextCursor }), error => error.message === "codex_history_read_failed" && error.nativeCode === -32600);
      assert.deepEqual((await client.request("thread/loaded/list")).data, []); client.assertHealthy(); await close();
      open(historyFile, true); assert.deepEqual(rows(), expectedProjection, "native read changed seeded projection"); db.close(); db = null;
      open(stateFile, true); assert.deepEqual(metadataRows(), expectedMetadata); db.close(); db = null;
      // Revert keeps the stable thread ID but selects a different physical
      // rollout ID via the state row. Old filename-derived identities are wrong.
      const reverted = paginatedFixture({ threadId: child.threadId, rolloutId: crypto.randomUUID(), cwd: home, historyBase: root.forkCutoff, suffix: "revert" });
      const revertedFile = path.join(codexHome, "archived_sessions", `rollout-2026-01-05T12-00-02-${child.threadId}_${reverted.rolloutId}.jsonl`);
      reverted.file = revertedFile;
      await save(revertedFile, reverted.raw);
      open(stateFile); assert.equal(db.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(revertedFile, child.threadId).changes, 1);
      expectedMetadata = metadataRows(); db.close(); db = null;
      open(historyFile); db.exec("BEGIN IMMEDIATE"); seed(reverted);
      // A deliberately lagging, but internally consistent, native projection.
      // Native item reads can succeed despite durable JSONL having more items.
      // This case is NOT counted as complete source history by our observation.
      db.prepare("DELETE FROM thread_items WHERE thread_id=? AND rollout_ordinal>=?").run(root.rolloutId, root.forkCutoff.end_ordinal_exclusive);
      db.prepare("DELETE FROM thread_turns WHERE thread_id=? AND rollout_ordinal>=?").run(root.rolloutId, root.forkCutoff.end_ordinal_exclusive);
      db.prepare("UPDATE thread_history_projection_state SET next_rollout_byte_offset=?,next_rollout_ordinal=? WHERE thread_id=?")
        .run(root.forkCutoff.end_byte_offset, root.forkCutoff.end_ordinal_exclusive, root.rolloutId);
      db.exec("COMMIT"); expectedProjection = rows(); db.close(); db = null;
      await start();
      const revertedMeta = (await client.request("thread/read", { threadId: child.threadId })).thread;
      assert.equal(revertedMeta.id, child.threadId); assert.equal(revertedMeta.name, child.name); assert.equal(revertedMeta.status.type, "notLoaded");
      const inherited = root.items.filter(it => it.createdOrdinal < root.forkCutoff.end_ordinal_exclusive);
      const revertedEntries = await collect("thread/items/list", { threadId: child.threadId }, revertedMeta);
      assert.deepEqual(revertedEntries, [...inherited, ...reverted.items].map(it => ({ turnId: it.turnId, item: it.item })));
      assert(revertedEntries.every(row => !row.turnId.startsWith("child-")), "superseded rollout must not leak into current history");
      const laggedMeta = (await client.request("thread/read", { threadId: root.threadId })).thread;
      const lagged = await client.request("thread/items/list", { threadId: root.threadId, limit: 50 });
      assert.deepEqual(lagged.data, inherited.map(it => ({ turnId: it.turnId, item: it.item }))); assert.equal(lagged.nextCursor, null);
      assert(lagged.data.length < root.items.length, "lagging projection must remain a known missing-history fixture");
      const laggedObservation = observePaginatedItems({ nativeVersion: snapshot.nativeVersion, threadId: root.threadId, turnId: null, thread: laggedMeta, page: lagged });
      assert.equal(laggedObservation.kind, "codex_paginated_items_observation"); assert.equal(laggedObservation.historyComplete, false); assert.equal(laggedObservation.publishable, false);
      assert.deepEqual((await client.request("thread/loaded/list")).data, []); client.assertHealthy(); await close();
      open(historyFile, true); assert.deepEqual(rows(), expectedProjection, "native reads must not materialize/repair lagging projection"); db.close(); db = null;
      open(stateFile, true); assert.deepEqual(metadataRows(), expectedMetadata); db.close(); db = null;
      for (const [file, bytes] of saved) assert.deepEqual(await fs.readFile(file), bytes, "native changed owned input file");
      assert.equal(requests, 0); assert.equal(physical, 0);
      // Differential: the bounded Rust ancestry parser must derive the same
      // inheritance pointer from the SAME first record native just consumed.
      // A divergence here means the parser and the real writer disagree.
      const ancestry = ancestryProbe
        ? probeAncestry(ancestryProbe, {
            threadId: child.threadId,
            entries: [reverted, root].map(f => ({
              rolloutId: f.rolloutId,
              base64Record: Buffer.from(firstRecord(f.raw)).toString("base64"),
              // The locator native actually stored for this rollout. A locator
              // is repository-relative with forward slashes on every OS, so
              // normalise Windows separators regardless of the running platform.
              rolloutPath: path.relative(codexHome, f.file).split(path.win32.sep).join("/"),
            })),
          })
        : null;
      if (ancestry) {
        assert.equal(ancestry.reachedRoot, true);
        assert.equal(ancestry.historyComplete, false);
        assert.equal(ancestry.sourceAuthenticated, false);
        assert.deepEqual(ancestry.links.map(link => link.rolloutId), [reverted.rolloutId, root.rolloutId]);
        assert.deepEqual(ancestry.links[0].historyBase, {
          threadId: root.forkCutoff.thread_id,
          endOrdinalExclusive: String(root.forkCutoff.end_ordinal_exclusive),
          endByteOffset: String(root.forkCutoff.end_byte_offset),
        }, "Rust ancestry parser disagrees with the record native inherited from");
        assert.equal(ancestry.links[1].historyBase, null);
        // The plan must schedule the inherited-from rollout BEFORE the child,
        // and carry the exact cut point native honoured when it inherited.
        assert.equal(ancestry.plan.threadId, child.threadId);
        assert.deepEqual(ancestry.plan.sources.map(s => s.rolloutId), [root.rolloutId, reverted.rolloutId]);
        // A cut describes how much of THAT source a descendant used, so it
        // belongs to the root the child inherited from, and the child itself
        // contributes through its end.
        assert.equal(ancestry.plan.sources[0].endOrdinalExclusive, String(root.forkCutoff.end_ordinal_exclusive));
        assert.equal(ancestry.plan.sources[0].endByteOffset, String(root.forkCutoff.end_byte_offset));
        assert.equal(ancestry.plan.sources[1].endOrdinalExclusive, null);
        assert.equal(ancestry.plan.reachedRoot, true);
        assert.equal(ancestry.plan.historyComplete, false);
        assert.equal(ancestry.plan.sources[0].archived, false);
        assert.equal(ancestry.plan.sources[1].archived, true);
        assert.equal(ancestry.plan.sources[1].rolloutPath,
          path.relative(codexHome, reverted.file).split(path.sep).join("/"));
      }
      let resolutionDifferential = "skipped_no_probe", resolutionNegativeControl = "skipped_no_probe";
      if (process.platform === "win32") {
        // The existing POSIX source boundary is intentionally unsupported on
        // Windows; require that explicit refusal rather than treating it as
        // an empty or partially resolved chain.
        try {
          await fs.access(paginatedResolutionProbe);
          const rootInfo = await fs.stat(codexHome, { bigint: true });
          const input = {
            protocolVersion: 15, nonce: "a".repeat(64), nativeVersion: snapshot.nativeVersion,
            codexRoot: codexHome,
            expectedRoot: { device: String(rootInfo.dev), inode: String(rootInfo.ino) },
            threadId: child.threadId, selectedRolloutId: reverted.rolloutId,
            entries: [reverted, root].map(f => ({ rolloutId: f.rolloutId,
              base64Record: Buffer.from(firstRecord(f.raw)).toString("base64"),
              rolloutPath: path.relative(codexHome, f.file).split(path.sep).join("/") }))
          };
          const refused = probePaginatedResolution(paginatedResolutionProbe, input);
          assert.deepEqual(refused.result, { kind: "source_unavailable", code: "source_platform_unsupported" });
          resolutionDifferential = "skipped_windows_source_unsupported";
          resolutionNegativeControl = "explicit_refusal_checked";
        } catch (error) {
          if (error?.code === "ENOENT") {
            resolutionDifferential = "skipped_no_probe";
            resolutionNegativeControl = "skipped_no_probe";
          } else throw error;
        }
      } else {
        let haveProbe = true;
        try { await fs.access(paginatedResolutionProbe); }
        catch (error) {
          if (error?.code === "ENOENT") haveProbe = false;
          else throw error;
        }
        if (!haveProbe) {
          resolutionNegativeControl = "skipped_no_probe";
        } else {
        const rootInfo = await fs.stat(codexHome, { bigint: true });
        const resolutionInput = {
          protocolVersion: 15,
          nonce: "a".repeat(64),
          nativeVersion: snapshot.nativeVersion,
          codexRoot: codexHome,
          expectedRoot: { device: String(rootInfo.dev), inode: String(rootInfo.ino) },
          threadId: child.threadId,
          selectedRolloutId: reverted.rolloutId,
          // The helper receives the same first metadata records native just
          // consumed and the exact relative locators it wrote in this owned
          // HOME. It opens both files itself; no bytes are sent back.
          entries: [reverted, root].map(f => ({
            rolloutId: f.rolloutId,
            base64Record: Buffer.from(firstRecord(f.raw)).toString("base64"),
            rolloutPath: path.relative(codexHome, f.file).split(path.sep).join("/")
          }))
        };
        const opened = probePaginatedResolution(paginatedResolutionProbe, resolutionInput);
        const expected = {
          nonce: resolutionInput.nonce, nativeVersion: snapshot.nativeVersion,
          threadId: child.threadId,
          rolloutIds: [root.rolloutId, reverted.rolloutId],
          rolloutPaths: [
            path.relative(codexHome, root.file).split(path.sep).join("/"),
            path.relative(codexHome, reverted.file).split(path.sep).join("/")
          ],
          storedBytes: [],
          decodedBytes: [],
          recordCounts: []
        };
        for (const fixture of [root, reverted]) {
          const info = await fs.stat(fixture.file, { bigint: true });
          expected.storedBytes.push(String(info.size));
          expected.decodedBytes.push(String(fixture.raw.length));
          expected.recordCounts.push(fixture.raw.filter(byte => byte === 0x0a).length);
        }
        assertResolutionDifferential(opened, expected);
        // Negative control: deliberately reverse the expected source order and
        // prove the differential assertion really fails before restoring the
        // correct expectation. This prevents a vacuous “probe ran” green light.
        const wrong = { ...expected, rolloutIds: [...expected.rolloutIds].reverse() };
        assert.throws(() => assertResolutionDifferential(opened, wrong), /deep-equal|strictly equal|source/);
        assertResolutionDifferential(opened, expected);
        resolutionDifferential = "matched_native_planned_source_openings";
        resolutionNegativeControl = "mismatch_rejected";
        }
      }
      return { result: "passed", nativeVersion: snapshot.nativeVersion, scope: "owned_seeded_paginated_projection_read_oracle", historySchemaSha256,
        ancestryDifferential: ancestry ? "matched_native_inherited_record" : "skipped_no_probe",
        resolutionDifferential, resolutionNegativeControl,
        itemPages, turnPages, observedPages, rootItems: 4, inheritedChildItems: 6, sameItemLatestSnapshotAtFirstCreatedOrdinal: true, forkCutoffExcludedLaterParentItems: true,
        equalItemIdsInDifferentTurnsPreserved: true, wrongThreadCursorRefused: true,
        revertedStableIdFromStatePath: true, archivedCurrentRolloutReadable: true, supersededRolloutExcluded: true,
        laggingProjectionNativeSuccessObserved: true, laggingProjectionNotPublished: true, selectedMetadataUnchangedAfterReads: true,
        nativeNames: true, singleTurnFilters: true, sourceFilesUnchanged: saved.size, seededProjectionUnchanged: true,
        nativeMaterializationVerified: false, fullThreadReadVerified: false, privateHistoryReads: 0, modelEndpointRequests: requests, loadedThreads: 0,
        ownedNativeStarts: starts, remainingChildren: physical, startupNotices: notices, cleanupConfirmed };
    } finally {
      if (db) { db.close(); db = null; }
      try { if (client) await close(); } finally {
        sink.closeAllConnections(); if (sink.listening) await new Promise(resolve => sink.close(resolve));
        if (cleanupConfirmed && physical === 0) await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        else throw new Error("owned_paginated_home_retained_cleanup_unknown");
      }
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [binary, ...extra] = process.argv.slice(2);
  assert(binary && extra.length === 0, "Usage: check-native-codex-paginated.mjs /absolute/native/codex");
  console.log(JSON.stringify(await checkPaginatedRuntime(binary)));
}
