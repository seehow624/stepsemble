// Exact pinned native-name oracle, exclusively generated disposable sources.
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
import { observeNameIndex } from "../protocol/native/codex/name-index.js";
import { nameCases } from "../protocol/native/codex/name-index-fixture.js";

const [binary, ...extra] = process.argv.slice(2);
assert(binary && path.isAbsolute(binary) && !extra.length, "one absolute pinned native binary required");
await withHistorySchemas(binary, async (snapshot) => {
  await verifyHistorySchemas(snapshot);
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-codex-names-owned-")));
  const codexHome = path.join(home, "codex"), saved = new Map(), cases = [];
  let client, cleanupConfirmed = false, requests = 0;
  const sink = createServer((_req, res) => { requests++; res.writeHead(503); res.end(); });
  try {
    await new Promise((resolve, reject) => { sink.once("error", reject); sink.listen(0, "127.0.0.1", () => { sink.removeListener("error", reject); resolve(); }); });
    const save = async (file, bytes) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 }); saved.set(file, Buffer.from(bytes)); };
    await save(path.join(codexHome, "config.toml"), `model_provider = "name_fixture"\ncli_auth_credentials_store = "file"\nproject_doc_max_bytes = 0\n[model_providers.name_fixture]\nname = "Owned names fixture"\nbase_url = "http://127.0.0.1:${sink.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\napps = false\nplugins = false\nhooks = false\nshell_snapshot = false\nmemories = false\nshell_tool = false\n[otel]\nexporter = "none"\n`);
    const records = [];
    for (let i = 0; i < nameCases("00000000-0000-4000-8000-000000000000", "preview").length; i++) {
      const id = crypto.randomUUID(), preview = `Owned first user text ${i}`, spec = nameCases(id, preview)[i], sec = String(i).padStart(2, "0");
      const timestamp = `2026-01-05T12:00:${sec}Z`, line = (type, payload) => JSON.stringify({ timestamp, type, payload });
      const raw = [line("session_meta", { id, session_id: id, timestamp, cwd: home, originator: "codex", cli_version: snapshot.nativeVersion,
        source: "cli", model_provider: "name_fixture", history_mode: "legacy" }),
        line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: preview }] }),
        line("event_msg", { type: "user_message", message: preview, text_elements: [], local_images: [] }),
      ].join("\n") + "\n";
      await save(path.join(codexHome, "sessions/2026/01/05", `rollout-2026-01-05T12-00-${sec}-${id}.jsonl`), raw);
      records.push(...spec.records); cases.push({ ...spec, id });
    }
    // The final case is a complete record without LF. The malformed case is an
    // interior rejected row here; a malformed *tail* is a separate unit case.
    const index = Buffer.from(records.join("\r\n")); await save(path.join(codexHome, "session_index.jsonl"), index);
    client = historyRpc(spawn(await fs.realpath(binary), ["app-server", "--listen", "stdio://"], {
      cwd: home, env: probeEnvironment(home), stdio: ["pipe", "pipe", "pipe"] }),
    { allowIndexRepair: true, allowOwnedLinuxSandboxNotice: process.platform === "linux" });
    await client.initialize(); assert.deepEqual((await client.request("thread/loaded/list")).data, []);
    // Read first, so list's scan-and-repair is not the prerequisite for names.
    for (const c of cases) {
      const observation = observeNameIndex(index, { nativeVersion: snapshot.nativeVersion, threadId: c.id });
      assert.equal(observation.kind, "codex_name_index_observation", c.label);
      assert.equal(observation.readCandidate, c.read, c.label); assert.equal(observation.listCandidate, c.list, c.label);
      assert.equal(observation.nativeTitleResolved, false);
      const { thread } = await client.request("thread/read", { threadId: c.id });
      assert.equal(thread.status.type, "notLoaded"); assert.deepEqual(thread.turns, []);
      if (c.label === "preview_name_read_list_difference") assert.equal(thread.preview, c.read, "the fixture name equals its native preview");
      assert.equal(thread.name, c.read, `native read ${c.label}`);
    }
    const listed = [], seen = new Set(); let cursor;
    for (let page = 0; page < 16; page++) {
      const result = await client.request("thread/list", { useStateDbOnly: false, limit: 3, ...(cursor ? { cursor } : {}) });
      listed.push(...result.data); cursor = result.nextCursor;
      if (!cursor) break; assert.ok(!seen.has(cursor), "name oracle cursor cycle"); seen.add(cursor);
    }
    assert.equal(cursor, null); assert.equal(listed.length, cases.length);
    for (const c of cases) assert.equal(listed.find(v => v.id === c.id)?.name, Object.hasOwn(c, "nativeList") ? c.nativeList : c.list, `native list ${c.label}`);
    for (const c of cases) {
      const { thread } = await client.request("thread/read", { threadId: c.id });
      assert.equal(thread.name, Object.hasOwn(c, "nativeRead") ? c.nativeRead : c.read, `native read after list ${c.label}`);
    }
    assert.deepEqual((await client.request("thread/loaded/list")).data, []); client.assertHealthy();
    ({ cleanupConfirmed } = await client.close()); assert.equal(cleanupConfirmed, true);
    for (const [file, bytes] of saved) assert.deepEqual(await fs.readFile(file), bytes, "owned source bytes changed");
    assert.equal(requests, 0);
    console.log(JSON.stringify({ result: "passed", nativeVersion: snapshot.nativeVersion, scope: "owned_legacy_name_index_fallback_only",
      cases: cases.length, caseLabels: cases.map(v => v.label), readAndListSeparatelyVerified: true,
      sqliteTitlePrecedenceVerified: false, paginatedNamesVerified: false, modelEndpointRequests: requests, loadedThreads: 0,
      sourceFilesUnchanged: saved.size, privateHistoryReads: 0, startupNotices: client.diagnostics().startupNotices, cleanupConfirmed }));
  } finally {
    if (client && !cleanupConfirmed) ({ cleanupConfirmed } = await client.close());
    sink.closeAllConnections(); if (sink.listening) await new Promise(resolve => sink.close(resolve));
    if (!client || cleanupConfirmed) await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    else throw new Error("codex_names_owned_home_retained_cleanup_unknown");
  }
});
