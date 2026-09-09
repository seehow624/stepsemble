#!/usr/bin/env node
// Actual application Host + owned pinned SQLite writer + native Rust reader.
// No Claude SDK, real native HOME, login, account, model or production mutation.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline";
import { zstdCompressSync, constants } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stageSyntheticArtifact } from "./history-host-synthetic.mjs";
import { setupHistory } from "./history-setup.mjs";
import { startOwnedSqliteWriter, snapshotOwnedSqlite } from "./check-native-codex-sqlite-pipeline.mjs";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const token = "synthetic-codex-host-only";
export async function startSyntheticCodexHistoryHost({ helperPath, port = 0 } = {}) {
  if (!["darwin", "linux"].includes(process.platform) || !path.isAbsolute(helperPath || "") || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("synthetic_codex_host_configuration_invalid");
  const helper = await fs.realpath(helperPath);
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-codex-host-owned-")));
  await fs.chmod(temp, 0o700);
  let writer, ready, child, exit, closing, expected, artifact, mutation = Promise.resolve();
  const stagedHelper = path.join(temp, "history-reader");
  async function snapshot() {
    const file = path.join(ready.codexRoot, ready.rolloutPath), index = await fs.readFile(path.join(ready.codexRoot, "session_index.jsonl"));
    const hashOptional = async file => {
      let handle; try {
        handle = await fs.open(file, "r"); const hash = crypto.createHash("sha256");
        for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 65536 })) hash.update(chunk);
        return hash.digest("hex");
      } catch (error) { if (error.code === "ENOENT") return null; throw error; } finally { await handle?.close(); }
    };
    return { sql: await snapshotOwnedSqlite(ready.sqliteRoot, { allowStoredLayout: true }), rollout: await hashOptional(file), compressed: await hashOptional(file + ".zst"), index: digest(index) };
  }
  async function stopChild(requireSuccess = true) {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    let timer;
    const outcome = await Promise.race([exit, new Promise(resolve => { timer = setTimeout(() => resolve(null), 15000); })]).finally(() => clearTimeout(timer));
    assert(outcome, "synthetic_codex_host_cleanup_unconfirmed_owned_fixtures_preserved");
    if (requireSuccess) assert(outcome[0] === 0 && outcome[1] === null, "synthetic_codex_host_failed_owned_fixtures_preserved");
  }
  let retainedRollout = null, largeDamageOffset = null;
  async function fixtureMutation(command) {
    // These are exact files under the fixture writer's owned temporary root,
    // never product source-reader operations or source paths from HTTP.
    const file = path.join(ready.codexRoot, ready.rolloutPath);
    if (["large_rollout", "many_records"].includes(command)) {
      assert(retainedRollout === null); const handle = await fs.open(file, "w"); let byteOffset = 0;
      try {
        for (let first = 0; first < 16384; first += 64) {
          const rows = [];
          for (let n = first; n < Math.min(first + 64, 16384); n++) {
            const value = n === 0 ? { type: "session_meta", payload: { id: ready.threadId, history_mode: "legacy", cli_version: "0.153.4" } }
              : n === 16383 ? { type: "future_owned_record", payload: { marker: "END-OF-OWNED-LARGE-HISTORY" } }
              : { type: "event_msg", payload: { type: "agent_message", message: `owned-large-${n} ` + (n === 1 ? "長".repeat(5000) + "END-OF-OWNED-LARGE-TEXT" : "x".repeat(command === "many_records" ? 4 : 960)) } };
            const row = JSON.stringify(value) + "\n"; if (n === 10000) largeDamageOffset = byteOffset;
            byteOffset += Buffer.byteLength(row); rows.push(row);
          }
          await handle.writeFile(rows.join(""));
        }
      } finally { await handle.close(); }
      assert(command === "many_records" ? byteOffset < 8 * 1024 * 1024 : byteOffset > 16 * 1024 * 1024); return;
    }
    if (["large_invalid_outside", "large_repair"].includes(command)) {
      assert(Number.isSafeInteger(largeDamageOffset)); const handle = await fs.open(file, "r+");
      try { await handle.write(Buffer.from(command === "large_repair" ? "{" : "!"), 0, 1, largeDamageOffset); } finally { await handle.close(); }
      return;
    }
    if (command === "large_append") {
      assert(Number.isSafeInteger(largeDamageOffset));
      await fs.appendFile(file, JSON.stringify({ type: "future_owned_record", payload: { marker: "OWNED-LARGE-APPEND" } }) + "\n"); return;
    }
    if (["compress", "compress_concat", "compress_corrupt"].includes(command)) {
      // A failed Buffer-vs-null equality assertion formats a massive diff.
      // This expected negative case must never retain/format transcript bytes.
      assert(retainedRollout === null, "synthetic_owned_compression_already_active"); retainedRollout = await fs.readFile(file);
      const encode = bytes => zstdCompressSync(bytes, { pledgedSrcSize: bytes.length, params: { [constants.ZSTD_c_checksumFlag]: 1 } });
      const encoded = command === "compress_concat" ? Buffer.concat([encode(retainedRollout.subarray(0, 29)), encode(retainedRollout.subarray(29))]) : encode(retainedRollout);
      if (command === "compress_corrupt") encoded[encoded.length - 1] ^= 1;
      await fs.writeFile(file + ".zst", encoded, { mode: 0o600, flag: "wx" }); await fs.unlink(file); return;
    }
    if (command === "restore_plain") {
      assert(retainedRollout); await fs.writeFile(file, retainedRollout, { mode: 0o600, flag: "wx" }); return;
    }
    if (command === "clear_compressed") {
      assert(retainedRollout); assert((await fs.readFile(file)).equals(retainedRollout), "synthetic_owned_plain_restore_mismatch");
      await fs.unlink(file + ".zst"); retainedRollout.fill(0); retainedRollout = null; return;
    }
    await writer.command(command);
  }
  try {
    artifact = await stageSyntheticArtifact(helper, stagedHelper, 0o500);
    writer = await startOwnedSqliteWriter(helper); ready = await writer.line(); assert.equal(ready.kind, "owned_writer_ready");
    await writer.command("rich_rollout"); expected = await snapshot();
    if (!port) {
      const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening"); port = probe.address().port;
      await new Promise(resolve => probe.close(resolve));
    }
    const origin = `http://127.0.0.1:${port}`, configPath = path.join(temp, "history.json");
    const answers = [configPath, origin, stagedHelper, ready.codexRoot, ready.sqliteRoot, "owned-codex", "Owned Codex · Synthetic only", "browser:master", "CREATE"];
    const setupResult = await setupHistory({ agent: "codex", ask: async () => answers.shift(), write() {} });
    assert.equal(setupResult.created, true); assert.equal(setupResult.sourceReads, 0); assert.equal(answers.length, 0);
    child = spawn(process.execPath, [path.join(repo, "server.js")], { cwd: temp, env: {
      HOME: temp, PI_HOME: temp, PATH: path.dirname(process.execPath), PI_BIN: path.join(temp, "no-native-agent"),
      STEPSEMBLE_TOKEN: token, STEPSEMBLE_HISTORY_CONFIG: configPath, STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_PORT: String(port),
      STEPSEMBLE_SECURE_COOKIE: "0", STEPSEMBLE_ORPHAN_EXIT: "0" }, stdio: ["ignore", "pipe", "pipe"], shell: false, detached: false });
    exit = once(child, "close"); child.stderr.resume();
    await new Promise((resolve, reject) => {
      let output = ""; const timer = setTimeout(() => reject(new Error("synthetic_codex_host_start_timeout")), 8000);
      child.stdout.on("data", chunk => { output = (output + chunk).slice(-8192); if (output.includes("listening on")) { clearTimeout(timer); resolve(); } });
      child.once("error", () => { clearTimeout(timer); reject(new Error("synthetic_codex_host_spawn_failed")); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("synthetic_codex_host_early_exit")); });
    });
    function close() {
      if (closing) return closing;
      closing = (async () => {
        await mutation; await stopChild();
        try {
          assert.deepEqual(await snapshot(), expected, "owned source bytes changed without explicit fixture mutation");
          assert.equal(digest(await fs.readFile(helper)), artifact.sha256); assert.equal(digest(await fs.readFile(stagedHelper)), artifact.sha256);
        } finally { await writer.stop(); await fs.rm(temp, { recursive: true, force: true }); }
        return { cleanupConfirmed: true, hostReaped: true, writerReaped: true, ownedDirectoriesRemoved: 2, sourcesUnchangedExceptExplicitMutation: true };
      })(); return closing;
    }
    return Object.freeze({ origin, token, threadId: ready.threadId, setupResult, artifact, close,
      async diagnostics() {
        // Only the exact owned child; never scan other processes or environments.
        if (child.exitCode !== null || child.signalCode !== null) return { hostRssBytes: null };
        if (process.platform === "darwin") {
          const { stdout } = await promisify(execFile)("/bin/ps", ["-o", "rss=", "-p", String(child.pid)], { timeout: 2000, maxBuffer: 1024 });
          const rss = stdout.trim(); return { hostRssBytes: /^\d+$/.test(rss) ? Number(rss) * 1024 : null };
        }
        if (process.platform !== "linux") return { hostRssBytes: null };
        const status = await fs.readFile(`/proc/${child.pid}/status`, "utf8");
        const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
        return { hostRssBytes: rss ? Number(rss[1]) * 1024 : null };
      },
      mutate(command) {
        if (closing || !["rename", "path", "paginated", "reset", "rich_rollout", "structured_rollout", "catalog_full", "catalog_reset", "missing", "cold", "reopen", "partial_sidecar", "remove_partial_sidecar",
          "compress", "compress_concat", "compress_corrupt", "restore_plain", "clear_compressed", "compressed_path", "plain_path",
          "large_rollout", "many_records", "large_invalid_outside", "large_repair", "large_append"].includes(command)) throw new Error("synthetic_codex_mutation_invalid");
        const next = mutation.then(async () => { assert.deepEqual(await snapshot(), expected); await fixtureMutation(command); expected = await snapshot(); });
        // The caller still receives the exact failure; the serialization tail
        // must settle so close/recovery can actually reap the owned processes.
        mutation = next.catch(() => {}); return next;
      } });
  } catch (error) {
    // A startup failure is already the primary error. Once its child has really
    // closed, still stop the owned writer rather than leaking it on exit != 0.
    await stopChild(false); if (writer) await writer.stop(); await fs.rm(temp, { recursive: true, force: true }); throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); assert.equal(args.length, 1);
  const host = await startSyntheticCodexHistoryHost({ helperPath: args[0] });
  console.log(JSON.stringify({ kind: "synthetic_codex_host_ready", origin: host.origin, syntheticSignInToken: host.token, privateHistoryReads: 0, modelCalls: 0, productionChanged: false }));
  const input = readline.createInterface({ input: process.stdin }); let ending = false;
  const stop = async () => { if (ending) return; ending = true; input.close(); console.log(JSON.stringify(await host.close())); };
  input.on("line", line => { void (async () => {
    if (line === "close") await stop(); else { await host.mutate(line); console.log("owned_codex_fixture_changed"); }
  })().catch(error => { console.error(error.message); process.exitCode = 1; }); });
  input.on("close", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); }); process.once("SIGINT", () => { void stop(); });
}
