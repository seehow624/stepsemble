#!/usr/bin/env node
// Owned Codex history contract fixture only. Never use the user's Codex home.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { capture, verifyCapture, probeEnvironment } from "./check-native-codex-schema.mjs";
import { historyRpc } from "../protocol/native/codex/history-rpc.js";
const exec = promisify(execFile), root = fileURLToPath(new URL("../", import.meta.url));
export const HISTORY_SCHEMAS = Object.freeze([
  "v2/ThreadListParams.json", "v2/ThreadListResponse.json", "v2/ThreadReadParams.json", "v2/ThreadReadResponse.json",
  "v2/ThreadTurnsListParams.json", "v2/ThreadTurnsListResponse.json", "v2/ThreadItemsListParams.json", "v2/ThreadItemsListResponse.json",
  "v2/ThreadLoadedListParams.json", "v2/ThreadLoadedListResponse.json",
]);
export async function withHistorySchemas(binary, consume) {
  const metadata = await capture(binary); await verifyCapture(metadata);
  if (metadata.nativeVersion !== "0.153.4") throw new Error("codex_history_version_unsupported");
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-codex-history-schema-")));
  try {
    const out = path.join(home, "schemas");
    await exec(await fs.realpath(binary), ["app-server", "generate-json-schema", "--out", out], {
      cwd: home, env: probeEnvironment(home), timeout: 20000, maxBuffer: 1024 * 1024 });
    const documents = new Map(), schemas = [];
    for (const file of HISTORY_SCHEMAS) {
      if ((await fs.stat(path.join(out, file))).size > 1024 * 1024) throw new Error("codex_history_schema_limit");
      const bytes = await fs.readFile(path.join(out, file));
      if (bytes.length > 1024 * 1024) throw new Error("codex_history_schema_limit");
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex"), known = metadata.schemas.find(row => row.file === file);
      if (known && (known.sha256 !== sha256 || known.bytes !== bytes.length)) throw new Error("codex_history_schema_changed");
      const document = JSON.parse(bytes.toString("utf8"));
      if (document.$schema !== "http://json-schema.org/draft-07/schema#") throw new Error("codex_history_schema_invalid");
      documents.set(file, document); schemas.push({ file, bytes: bytes.length, sha256 });
    }
    return await consume({ fixtureVersion: 1, nativeVersion: metadata.nativeVersion, schemas }, documents);
  } finally { await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
export async function verifyHistorySchemas(snapshot) {
  const expected = JSON.parse(await fs.readFile(path.join(root, "protocol/native/codex/0.153.4-history-schema.json"), "utf8"));
  assert.deepEqual(snapshot, expected, "codex_history_schema_drift");
}
// Synthetic data only, based on the official codex-rs app-server rollout tests.
// No caller-supplied home, source path, transcript, credentials, or provider config.
export async function checkHistoryRuntime(binary) {
  return withHistorySchemas(binary, async snapshot => {
    await verifyHistorySchemas(snapshot);
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-codex-history-owned-")));
    const codexHome = path.join(home, "codex"), saved = new Map(), fixtures = [];
    let client, cleanupConfirmed = false;
    const save = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text, { flag: "wx", mode: 0o600 }); saved.set(file, text); };
    try {
      // Dedicated local endpoint records any unexpected model request, without an external account.
      const { createServer } = await import("node:http");
      let requests = 0;
      const sink = createServer((_req, res) => { requests++; res.writeHead(503); res.end(); });
      await new Promise(resolve => sink.listen(0, "127.0.0.1", resolve));
      try {
        const config = `model_provider = "history_fixture"\nproject_doc_max_bytes = 0\n[model_providers.history_fixture]\nname = "Owned history fixture"\nbase_url = "http://127.0.0.1:${sink.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\napps = false\nplugins = false\nhooks = false\nshell_snapshot = false\nmemories = false\nshell_tool = false\n[otel]\nexporter = "none"\n`;
        await save(path.join(codexHome, "config.toml"), config);
        for (const [i, source] of ["cli", "vscode", "exec", "mcp", { subagent: "review" }, "unknown", "cli", "cli"].entries()) {
          const id = crypto.randomUUID(), archived = i === 7, paginated = i === 6;
          const name = `原生完整名稱 ${i} — ${"貓掌🐾長名稱 ".repeat(20)}`;
          const timestamp = `2026-01-05T12:00:0${i}Z`, line = (type, payload) => ({ timestamp, type, payload });
          const lines = [line("session_meta", { id, session_id: id, timestamp, cwd: home, originator: "codex", cli_version: snapshot.nativeVersion,
            source, model_provider: "history_fixture", history_mode: paginated ? "paginated" : "legacy" })];
          for (let turn = 0; turn < 7; turn++) {
            const message = `使用者 ${i}/${turn} <script>not executable</script>`;
            lines.push(line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: message }] }),
              line("event_msg", { type: "user_message", message, text_elements: [], local_images: [] }),
              line("event_msg", { type: "agent_message", message: `草稿 ${i}/${turn}` }),
              line("event_msg", { type: "agent_message", message: `回答 ${i}/${turn} 🐾` }));
          }
          if (paginated) lines.forEach((entry, ordinal) => { entry.ordinal = ordinal; });
          const file = path.join(codexHome, archived ? "archived_sessions" : "sessions/2026/01/05", `rollout-2026-01-05T12-00-0${i}-${id}.jsonl`);
          await save(file, lines.map(value => JSON.stringify(value)).join("\n") + "\n"); fixtures.push({ id, name, paginated, archived, source });
        }
        await save(path.join(codexHome, "session_index.jsonl"), fixtures.flatMap(row => [
          { id: row.id, thread_name: "舊名字", updated_at: "2026-01-05T12:00:00Z" },
          { id: row.id, thread_name: row.name, updated_at: "2026-01-05T12:30:00Z" },
        ]).map(value => JSON.stringify(value)).join("\n") + "\n");
        const child = spawn(await fs.realpath(binary), ["app-server", "--listen", "stdio://"], { cwd: home, env: probeEnvironment(home), stdio: ["pipe", "pipe", "pipe"] });
        client = historyRpc(child, { allowIndexRepair: true });
        await client.initialize();
        assert.deepEqual((await client.request("thread/loaded/list")).data, []);
        const collect = async (method, params) => {
          const rows = [], cursors = new Set(); let cursor;
          for (let page = 0; page < 32; page++) {
            const result = await client.request(method, { ...params, limit: 2, ...(cursor ? { cursor } : {}) });
            assert.ok(Array.isArray(result.data)); rows.push(...result.data);
            if (!result.nextCursor) return rows;
            assert.ok(!cursors.has(result.nextCursor), "cursor cycle"); cursors.add(result.nextCursor); cursor = result.nextCursor;
          }
          throw new Error("codex_history_fixture_page_limit");
        };
        const active = await collect("thread/list", { useStateDbOnly: false }), archived = await collect("thread/list", { archived: true, useStateDbOnly: false });
        assert.deepEqual(active.map(row => row.id).sort(), fixtures.filter(row => !row.archived).map(row => row.id).sort());
        assert.deepEqual(archived.map(row => row.id), fixtures.filter(row => row.archived).map(row => row.id));
        let legacyTurns = 0, legacyItems = 0, paginatedProjection, itemsList = "not_checked";
        for (const fixture of fixtures) {
          const { thread } = await client.request("thread/read", { threadId: fixture.id });
          // This pinned build does not hydrate paginated names from the legacy session index.
          assert.equal(thread.name, fixture.paginated ? null : fixture.name);
          assert.equal(thread.status.type, "notLoaded"); assert.deepEqual(thread.turns, []);
          assert.equal(thread.historyMode, fixture.paginated ? "paginated" : "legacy");
          assert.deepEqual(thread.source, fixture.source === "mcp" ? "appServer" : typeof fixture.source === "object" ? { subAgent: "review" } : fixture.source);
          assert.notEqual(thread.preview, fixture.name);
          const turns = await collect("thread/turns/list", { threadId: fixture.id });
          if (fixture.paginated) { paginatedProjection = turns.length; assert.equal(paginatedProjection, 0, "re-review native paginated projection behavior"); continue; }
          const full = await client.request("thread/read", { threadId: fixture.id, includeTurns: true });
          assert.equal(turns.length, 7); assert.deepEqual(turns, full.thread.turns);
          assert.ok(turns.every(turn => turn.itemsView === "full" && turn.items.length === 3));
          assert.ok(turns.every((turn, i) => turn.items[1].text === `草稿 ${fixtures.indexOf(fixture)}/${i}` && turn.items[2].text === `回答 ${fixtures.indexOf(fixture)}/${i} 🐾`));
          if (itemsList === "not_checked") {
            try {
              const entries = await collect("thread/items/list", { threadId: fixture.id, turnId: turns[0].id });
              assert.ok(entries.every(entry => entry.turnId === turns[0].id));
              assert.deepEqual(entries.map(entry => entry.item), turns[0].items); itemsList = "supported";
            } catch (error) {
              if (error.message !== "codex_history_method_unavailable" || error.nativeCode !== -32601) throw error;
              itemsList = "native_method_unavailable";
            }
          }
          legacyTurns += turns.length; legacyItems += turns.flatMap(turn => turn.items).length;
        }
        client.assertHealthy(); assert.deepEqual((await client.request("thread/loaded/list")).data, []); client.assertHealthy();
        ({ cleanupConfirmed } = await client.close()); assert.equal(cleanupConfirmed, true);
        for (const [file, text] of saved) assert.deepEqual(await fs.readFile(file), Buffer.from(text), "owned source changed");
        assert.equal(requests, 0);
        return { nativeVersion: snapshot.nativeVersion, schemaCount: snapshot.schemas.length, scope: "owned-synthetic-home-only", active: active.length, archived: archived.length,
          legacyTurns, legacyItems, paginatedProjection, paginatedName: "unavailable_from_legacy_index", itemsList,
          modelEndpointRequests: requests, loadedThreads: 0, sourceFilesUnchanged: saved.size, cleanupConfirmed };
      } finally { sink.closeAllConnections(); await new Promise(resolve => sink.close(resolve)); }
    } finally {
      if (client && !cleanupConfirmed) ({ cleanupConfirmed } = await client.close());
      // Never erase an owned workspace while process cleanup remains unknown.
      if (!client || cleanupConfirmed) await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      else throw new Error("codex_history_cleanup_unknown_owned_home_retained");
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [binary, flag, ...rest] = process.argv.slice(2);
  if (!binary || rest.length || !["--inspect", "--record", "--runtime"].includes(flag)) throw new Error("Usage: check-native-codex-history.mjs /absolute/native/codex --inspect|--record|--runtime");
  if (flag === "--runtime") console.log(JSON.stringify(await checkHistoryRuntime(binary)));
  else await withHistorySchemas(binary, async (snapshot, documents) => {
    if (flag === "--record") {
      const target = path.join(root, `protocol/native/codex/${snapshot.nativeVersion}-history-schema.json`);
      await fs.writeFile(target, JSON.stringify(snapshot, null, 2) + "\n", { flag: "wx" });
      console.log(JSON.stringify(snapshot));
    } else {
      for (const [file, document] of documents) console.log(JSON.stringify({ file, required: document.required, properties: document.properties,
        definitions: document.definitions }));
    }
  });
}
