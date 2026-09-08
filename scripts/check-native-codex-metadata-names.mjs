// Pinned native oracle using only generated, disposable history and SQLite.
// The fixture DB is edited only between native processes, after actual close.
// This is NOT a production SQLite reader, live backup or private-source grant.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { withHistorySchemas, verifyHistorySchemas } from "./check-native-codex-history.mjs";
import { probeEnvironment } from "./check-native-codex-schema.mjs";
import { historyRpc } from "../protocol/native/codex/history-rpc.js";
import { observeMetadataName } from "../protocol/native/codex/metadata-name.js";
import { metadataNameCases } from "../protocol/native/codex/metadata-name-fixture.js";
import { createLineDecoder } from "../server/stream-safety.js";

const [binary, ...extra] = process.argv.slice(2);
assert(binary && path.isAbsolute(binary) && !extra.length, "one absolute pinned native binary required");
await withHistorySchemas(binary, async snapshot => {
  await verifyHistorySchemas(snapshot);
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-codex-db-names-owned-")));
  const codexHome = path.join(home, "codex"), sqliteHome = path.join(home, "explicit-sqlite"), decoy = path.join(home, "env-sqlite-decoy");
  const saved = new Map(), cases = [], notices = [], env = { ...probeEnvironment(home), CODEX_SQLITE_HOME: decoy };
  let client = null, db = null, cleanupConfirmed = true, physical = 0, starts = 0, requests = 0, sqliteVersion;
  const nativeEventKinds = [];
  const sink = createServer((_req, res) => { requests++; res.writeHead(503); res.end(); });
  const save = async (file, bytes) => { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 }); saved.set(file, Buffer.from(bytes)); };
  const start = async () => {
    assert.equal(db, null, "fixture SQLite connection must close before native startup"); assert.equal(physical, 0); assert.equal(cleanupConfirmed, true);
    const child = spawn(await fs.realpath(binary), ["app-server", "--listen", "stdio://"], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    physical++; starts++; cleanupConfirmed = false; child.once("close", () => { physical--; });
    const trace = createLineDecoder({ maxBytes: 2 * 1024 * 1024, onError() {}, onLine(line) {
      try { const frame = JSON.parse(line); if (typeof frame.method === "string" && nativeEventKinds.length < 32)
        nativeEventKinds.push({ method: frame.method, parameterKeys: Object.keys(frame.params ?? {}), statusType: frame.params?.status?.type ?? null }); } catch {}
    } }); child.stdout.on("data", chunk => trace.push(chunk));
    client = historyRpc(child, { allowIndexRepair: true, allowOwnedLinuxSandboxNotice: process.platform === "linux" });
    await client.initialize(); assert.deepEqual((await client.request("thread/loaded/list")).data, []);
  };
  const close = async () => {
    if (!client) return;
    notices.push(...client.diagnostics().startupNotices);
    ({ cleanupConfirmed } = await client.close()); assert.equal(cleanupConfirmed, true); assert.equal(physical, 0); client = null;
  };
  const list = async useStateDbOnly => {
    const rows = [], seen = new Set(); let cursor;
    for (let page = 0; page < 16; page++) {
      const r = await client.request("thread/list", { useStateDbOnly, limit: 3, ...(cursor ? { cursor } : {}) });
      rows.push(...r.data); cursor = r.nextCursor;
      if (cursor === null) break; assert(!seen.has(cursor), "cursor cycle"); seen.add(cursor);
    }
    assert.equal(cursor, null); assert.equal(new Set(rows.map(r => r.id)).size, rows.length); assert.equal(rows.length, cases.length); return rows;
  };
  const nameFields = db => db.prepare("SELECT id, history_mode, title, first_user_message, name FROM threads ORDER BY id").all();
  try {
    await new Promise((resolve, reject) => { sink.once("error", reject); sink.listen(0, "127.0.0.1", () => { sink.removeListener("error", reject); resolve(); }); });
    await fs.mkdir(sqliteHome, { mode: 0o700 }); await fs.mkdir(decoy, { mode: 0o700 });
    await save(path.join(codexHome, "config.toml"), `sqlite_home = ${JSON.stringify(sqliteHome)}\nmodel_provider = "db_name_fixture"\ncli_auth_credentials_store = "file"\nproject_doc_max_bytes = 0\n[model_providers.db_name_fixture]\nname = "Owned DB names fixture"\nbase_url = "http://127.0.0.1:${sink.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\napps = false\nplugins = false\nhooks = false\nshell_snapshot = false\nmemories = false\nshell_tool = false\n[otel]\nexporter = "none"\n`);
    for (const [i, spec] of metadataNameCases().entries()) {
      const id = crypto.randomUUID(), sec = String(i).padStart(2, "0"), timestamp = `2026-01-05T12:00:${sec}Z`;
      const line = (type, payload) => JSON.stringify({ timestamp, type, payload });
      const rows = [line("session_meta", { id, session_id: id, timestamp, cwd: home, originator: "codex", cli_version: snapshot.nativeVersion,
        source: "cli", model_provider: "db_name_fixture", history_mode: "legacy" }),
        line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "preview" }] }),
        line("event_msg", { type: "user_message", message: "preview", text_elements: [], local_images: [] })];
      const file = path.join(codexHome, "sessions/2026/01/05", `rollout-2026-01-05T12-00-${sec}-${id}.jsonl`);
      await save(file, rows.join("\n") + "\n"); cases.push({ ...spec, id, file, rows });
    }
    await save(path.join(codexHome, "session_index.jsonl"), cases.map(c => JSON.stringify({ id: c.id, thread_name: c.index, updated_at: "x" })).join("\n") + "\n");
    // Ask the native implementation to create/migrate its own schema and rows.
    // No handwritten DB schema and no thread/name/set or generation request.
    await start(); await list(false);
    for (const c of cases) assert.equal((await client.request("thread/read", { threadId: c.id })).thread.id, c.id);
    client.assertHealthy(); await close();
    assert.deepEqual(await fs.readdir(decoy), []); assert.equal((await fs.readdir(codexHome)).some(v => v.startsWith("state_")), false);
    const dbFile = path.join(sqliteHome, "state_5.sqlite"); assert((await fs.lstat(dbFile)).isFile());
    // Node's fixture SQLite may predate the native WAL-reset fix. It is used
    // only for trusted generated rows with NO concurrent connections/processes.
    // It must not be reused for production snapshots or real user databases.
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(dbFile, { allowExtension: false }); db.exec("PRAGMA trusted_schema=OFF");
    sqliteVersion = db.prepare("SELECT sqlite_version() AS version").get().version;
    const threadsSchema = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='threads'").get().sql;
    const expectedSchema = (await fs.readFile(new URL("../protocol/native/codex/sqlite-threads-0.153.4.sql", import.meta.url), "utf8")).trim();
    assert.equal(threadsSchema, expectedSchema, "pinned threads schema must match the real native-created database");
    assert.equal(nameFields(db).length, cases.length);
    const update = db.prepare("UPDATE threads SET history_mode=?, title=?, first_user_message=?, name=? WHERE id=?");
    db.exec("BEGIN IMMEDIATE");
    for (const c of cases) assert.equal(update.run(c.mode, c.title, c.first, c.name, c.id).changes, 1);
    db.exec("COMMIT");
    const expectedRows = nameFields(db).map(r => ({ ...r }));
    for (const c of cases) {
      const observation = observeMetadataName(expectedRows.find(r => r.id === c.id), { nativeVersion: snapshot.nativeVersion, threadId: c.id });
      assert.equal(observation.kind, "codex_metadata_name_observation", c.label); assert.equal(observation.candidate, c.candidate, c.label);
    }
    db.close(); db = null;
    for (const c of cases.filter(c => c.mode === "paginated")) {
      const record = JSON.parse(c.rows[0]); record.payload.history_mode = "paginated"; c.rows[0] = JSON.stringify(record);
      const raw = Buffer.from(c.rows.join("\n") + "\n"); await fs.writeFile(c.file, raw); saved.set(c.file, raw);
    }
    await start();
    for (const c of cases) {
      const { thread } = await client.request("thread/read", { threadId: c.id });
      assert.equal(thread.name, c.read, `read before list: ${c.label}`); assert.equal(thread.status.type, "notLoaded"); assert.deepEqual(thread.turns, []);
      if (c.mode === "legacy") assert.equal((await client.request("thread/read", { threadId: c.id, includeTurns: true })).thread.name, c.read, `read history: ${c.label}`);
    }
    for (const stateOnly of [true, false]) {
      const listed = await list(stateOnly);
      for (const c of cases) assert.equal(listed.find(r => r.id === c.id)?.name, c.list, `list stateOnly=${stateOnly}: ${c.label}`);
    }
    for (const c of cases) assert.equal((await client.request("thread/read", { threadId: c.id })).thread.name, c.read, `read after list: ${c.label}`);
    assert.deepEqual((await client.request("thread/loaded/list")).data, []); client.assertHealthy();
    // Preserve the failed full-history gate as a separate terminal probe. The
    // pinned server emits a deprecation notice, which the strict read channel
    // refuses; do not broaden that channel just to claim paginated support.
    await assert.rejects(client.request("thread/read", { threadId: cases.find(c => c.mode === "paginated").id, includeTurns: true }),
      e => e.message === "codex_history_unexpected_native_event");
    assert.equal(nativeEventKinds.at(-1).method, "deprecationNotice"); await close();
    db = new DatabaseSync(dbFile, { readOnly: true, allowExtension: false }); db.exec("PRAGMA trusted_schema=OFF");
    assert.deepEqual(nameFields(db).map(r => ({ ...r })), expectedRows, "native reads must preserve selected fixture metadata columns"); db.close(); db = null;
    for (const [file, bytes] of saved) assert.deepEqual(await fs.readFile(file), bytes, "native changed owned rollout/index/config outside explicit setup");
    assert.equal(requests, 0); assert.equal(physical, 0);
    console.log(JSON.stringify({ result: "passed", nativeVersion: snapshot.nativeVersion, scope: "owned_sqlite_name_precedence_only", cases: cases.length,
      caseLabels: cases.map(c => c.label), legacyCases: cases.filter(c => c.mode === "legacy").length, paginatedMetadataCases: cases.filter(c => c.mode === "paginated").length,
      sqliteConfigOverridesEnvVerified: true, separateSqliteHome: true, sqliteFixtureVersion: sqliteVersion, fixtureMutationOnlyWithNativeClosed: true,
      sqliteThreadsSchemaSha256: crypto.createHash("sha256").update(threadsSchema).digest("hex"),
      databaseNameFieldsUnchangedAfterReads: true, stateOnlyAndScanListsVerified: true, metadataReadBeforeAfterVerified: true, legacyReadWithHistoryVerified: true,
      paginatedFullHistorySupported: false, paginatedFullHistoryProbe: "unavailable_deprecation_notice_refused", ownedNativeStarts: starts, remainingChildren: physical, modelEndpointRequests: requests, loadedThreads: 0,
      sourceFilesUnchangedExceptExplicitSetup: saved.size, privateHistoryReads: 0, productionSqliteReader: false, startupNotices: notices, cleanupConfirmed }));
  } catch (error) {
    console.error(JSON.stringify({ ownedFixtureNativeEventKinds: nativeEventKinds })); throw error;
  } finally {
    if (db) { db.close(); db = null; }
    if (client) await close();
    sink.closeAllConnections(); if (sink.listening) await new Promise(resolve => sink.close(resolve));
    if (cleanupConfirmed && physical === 0) await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    else throw new Error("codex_db_names_owned_home_retained_cleanup_unknown");
  }
});
