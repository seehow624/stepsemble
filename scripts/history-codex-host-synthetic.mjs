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
import { spawn } from "node:child_process";
import readline from "node:readline";
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
    const rollout = await fs.readFile(path.join(ready.codexRoot, ready.rolloutPath)), index = await fs.readFile(path.join(ready.codexRoot, "session_index.jsonl"));
    return { sql: await snapshotOwnedSqlite(ready.sqliteRoot, { allowStoredLayout: true }), rollout: digest(rollout), index: digest(index) };
  }
  async function stopChild(requireSuccess = true) {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    let timer;
    const outcome = await Promise.race([exit, new Promise(resolve => { timer = setTimeout(() => resolve(null), 15000); })]).finally(() => clearTimeout(timer));
    assert(outcome, "synthetic_codex_host_cleanup_unconfirmed_owned_fixtures_preserved");
    if (requireSuccess) assert(outcome[0] === 0 && outcome[1] === null, "synthetic_codex_host_failed_owned_fixtures_preserved");
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
        await mutation; await stopChild(); assert.deepEqual(await snapshot(), expected, "owned source bytes changed without explicit fixture mutation");
        assert.equal(digest(await fs.readFile(helper)), artifact.sha256); assert.equal(digest(await fs.readFile(stagedHelper)), artifact.sha256);
        await writer.stop(); await fs.rm(temp, { recursive: true, force: true });
        return { cleanupConfirmed: true, hostReaped: true, writerReaped: true, ownedDirectoriesRemoved: 2, sourcesUnchangedExceptExplicitMutation: true };
      })(); return closing;
    }
    return Object.freeze({ origin, token, threadId: ready.threadId, setupResult, artifact, close,
      mutate(command) {
        if (closing || !["rename", "path", "paginated", "reset", "rich_rollout", "catalog_full", "catalog_reset", "missing", "cold", "reopen", "partial_sidecar", "remove_partial_sidecar"].includes(command)) throw new Error("synthetic_codex_mutation_invalid");
        const next = mutation.then(async () => { assert.deepEqual(await snapshot(), expected); await writer.command(command); expected = await snapshot(); });
        mutation = next; return next;
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
