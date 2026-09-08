#!/usr/bin/env node
// Runs the actual application Host with a private, owned synthetic home. No
// native login, real-history discovery, model invocation or production update.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import readline from "node:readline";
import fixture from "../protocol/native/claude/history-fixture.cjs";
import trust from "../server/device-trust.js";
import { SDK_SHA256 } from "../protocol/native/claude/history-sdk.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const token = "synthetic-history-host-only", issuedToken = "synthetic-issued-history-only", issuedId = "123456789abc";
const encode = records => Buffer.from(records.map(row => JSON.stringify(row)).join("\n") + "\n");

// Test artifacts are staged into a caller-owned private fixture directory.
// Cargo can hard-link its executable outputs; never chmod those shared inputs
// or relax the application's single-link/executable policy to accommodate CI.
export async function stageSyntheticArtifact(source, destination, mode) {
  if (![0o500, 0o600].includes(mode)) throw new Error("synthetic_artifact_mode_invalid");
  const before = await fs.stat(source, { bigint: true });
  if (!before.isFile()) throw new Error("synthetic_artifact_not_regular");
  const sha256 = digest(await fs.readFile(source));
  await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  await fs.chmod(destination, mode);
  const after = await fs.stat(source, { bigint: true }), staged = await fs.lstat(destination, { bigint: true });
  if (!["dev", "ino", "size", "mtimeNs", "ctimeNs", "uid", "mode", "nlink"].every(k => before[k] === after[k])
    || !staged.isFile() || staged.nlink !== 1n || staged.uid !== BigInt(process.geteuid())
    || (staged.mode & 0o777n) !== BigInt(mode) || (staged.dev === before.dev && staged.ino === before.ino)
    || digest(await fs.readFile(source)) !== sha256 || digest(await fs.readFile(destination)) !== sha256)
    throw new Error("synthetic_artifact_copy_mismatch");
  return { sha256, sourceLinks: Number(before.nlink), sourceMode: Number(before.mode & 0o777n), stagedLinks: Number(staged.nlink), stagedMode: mode };
}

export async function startSyntheticHistoryHost({ helperPath, sdkPath, port = 0, sourceGroups = false, extraSessions = 0 } = {}) {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("history_host_native_platform_unsupported");
  if (!path.isAbsolute(helperPath || "") || !path.isAbsolute(sdkPath || "") || !Number.isInteger(port) || port < 0 || port > 65535 || typeof sourceGroups !== "boolean"
    || !Number.isSafeInteger(extraSessions) || extraSessions < 0 || extraSessions > 96 || extraSessions > 0 && !sourceGroups)
    throw new Error("synthetic_history_host_configuration_invalid");
  const helper = await fs.realpath(helperPath), sdk = await fs.realpath(sdkPath);
  const helperHash = digest(await fs.readFile(helper)), sdkHash = digest(await fs.readFile(sdk));
  if (sdkHash !== SDK_SHA256) throw new Error("synthetic_history_sdk_pin_mismatch");
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-history-host-native-")));
  let child, exit, closed, mutation = Promise.resolve(); const files = new Map();
  try {
    const artifacts = path.join(temp, "artifacts"); await fs.mkdir(artifacts, { mode: 0o700 });
    const stagedHelper = path.join(artifacts, "history-reader"), stagedSdk = path.join(artifacts, "sdk.mjs");
    const helperArtifact = await stageSyntheticArtifact(helper, stagedHelper, 0o500);
    const sdkArtifact = await stageSyntheticArtifact(sdk, stagedSdk, 0o600);
    const packageArtifact = await stageSyntheticArtifact(path.join(path.dirname(sdk), "package.json"), path.join(artifacts, "package.json"), 0o600);
    if (helperArtifact.sha256 !== helperHash || sdkArtifact.sha256 !== sdkHash) throw new Error("synthetic_history_artifact_changed");
    if (!port) { const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening"); port = probe.address().port; await new Promise(resolve => probe.close(resolve)); }
    const origin = `http://127.0.0.1:${port}`, projectsRoot = path.join(temp, "projects"), projectKey = "-owned-host", project = path.join(projectsRoot, projectKey);
    await fs.mkdir(project, { recursive: true, mode: 0o700 }); await fs.chmod(projectsRoot, 0o700); await fs.chmod(project, 0o700);
    const configDir = path.join(temp, ".config/stepsemble"); await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(configDir, "tokens.json"), JSON.stringify({ tokens: [{ id: issuedId, hash: digest(issuedToken), label: "Synthetic issued reader" }] }), { mode: 0o600 });
    const store = trust.createDeviceTrustStore({ filePath: path.join(configDir, "device-trust.json") });
    const device = { id: "synthetic-host", name: "Synthetic Host", host: "synthetic.invalid", url: origin };
    const offer = store.createOffer(device), decoded = trust.decodePairingCode(offer.offer);
    const consumed = store.consumePairingOffer({ offerId: decoded.offerId, secret: decoded.secret,
      requestingDevice: { id: "synthetic-gateway", name: "Synthetic Gateway", host: "synthetic.invalid", url: origin } });
    const peer = { grantId: consumed.grant.id, credential: consumed.grant.credential };
    const cases = fixture.richCases("/synthetic/host");
    const longId = fixture.uuid(52000);
    cases.push({ name: "long", sessionId: longId, expectedIds: Array.from({ length: 35 }, (_, i) => fixture.uuid(52100 + i)),
      records: Array.from({ length: 35 }, (_, i) => ({ type: "user", sessionId: longId, uuid: fixture.uuid(52100 + i), parentUuid: i ? fixture.uuid(52099 + i) : null,
        timestamp: "2026-09-08T00:00:00.000Z", message: { role: "user", content: `合成訊息 ${i + 1}：長對話按需分頁。🐾\n` + "這不是私人歷史，也不會執行工具。".repeat(8) } })) });
    const labels = { rich: "工具與思考", compaction: "壓縮後的脈絡", "file-history": "檔案歷史描述", long: "長對話 · 35 則" };
    for (let i = 0; i < extraSessions; i++) {
      const sessionId = fixture.uuid(60000 + i), messageId = fixture.uuid(61000 + i);
      cases.push({ name: `extra-${i}`, sessionId, expectedIds: [messageId], records: [
        { type: "user", sessionId, uuid: messageId, parentUuid: null, message: { role: "user", content: `合成來源 ${i + 1} 的完整內容 🐾` } },
        { type: "custom-title", sessionId, customTitle: `合成對話 ${i + 1} 🐾 <script>never()</script>` + (i === 0 ? "長名稱保留原文。".repeat(20) : "") }
      ] });
    }
    const stat = await fs.stat(projectsRoot, { bigint: true });
    const catalog = [];
    for (const c of cases) {
      const filename = path.join(project, `${c.sessionId}.jsonl`), bytes = encode(c.records);
      await fs.writeFile(filename, bytes, { mode: 0o600, flag: "wx" }); files.set(c.name, { filename, bytes, present: true });
      if (c.name.startsWith("extra-")) continue;
      catalog.push({ catalogId: `fixture-${c.name}`, label: labels[c.name], description: "此隔離主機只有合成資料，沒有連接真實帳號。",
        source: { projectsRoot, projectKey, sessionId: c.sessionId }, expectedRoot: { device: String(stat.dev), inode: String(stat.ino) },
        readers: ["browser:master", `browser:${issuedId}`, `peer:${peer.grantId}`] });
    }
    const configPath = path.join(temp, "history.json");
    await fs.writeFile(configPath, JSON.stringify({ version: sourceGroups ? 2 : 1, trustBoundary: "host_managed_paths", allowedOrigins: [origin],
      reader: { helperPath: stagedHelper, sdkPath: stagedSdk }, catalog,
      ...(sourceGroups ? { sourceGroups: [{ sourceId: "fixture-root", agentId: "claude-code", scope: "main_sessions", label: "Owned synthetic Claude root", description: "No private history",
        projectsRoot, expectedRoot: { device: String(stat.dev), inode: String(stat.ino) }, readers: ["browser:master", `browser:${issuedId}`, `peer:${peer.grantId}`] }] } : {}) }),
    { mode: 0o600, flag: "wx" });
    child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: temp, env: {
      HOME: temp, PI_HOME: temp, PATH: path.dirname(process.execPath), PI_BIN: path.join(temp, "no-native-agent"),
      STEPSEMBLE_TOKEN: token, STEPSEMBLE_HISTORY_CONFIG: configPath, STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_PORT: String(port),
      STEPSEMBLE_SECURE_COOKIE: "0", STEPSEMBLE_ORPHAN_EXIT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    exit = once(child, "close"); child.stderr.resume();
    await new Promise((resolve, reject) => {
      let output = ""; const timer = setTimeout(() => reject(new Error("synthetic_history_host_start_timeout")), 8000);
      child.stdout.on("data", chunk => { output = (output + chunk).slice(-8192); if (output.includes("listening on")) { clearTimeout(timer); resolve(); } });
      child.once("error", () => { clearTimeout(timer); reject(new Error("synthetic_history_host_spawn_failed")); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("synthetic_history_host_early_exit")); });
    });
    async function close() {
      if (closed) return closed;
      closed = (async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        let timer;
        const result = await Promise.race([exit, new Promise(resolve => { timer = setTimeout(() => resolve(null), 15000); })]).finally(() => clearTimeout(timer));
        if (!result || result[0] !== 0 || result[1] !== null) throw new Error("synthetic_history_host_cleanup_unconfirmed_fixtures_preserved");
        await mutation;
        for (const row of files.values()) {
          if (row.present ? !(await fs.readFile(row.filename)).equals(row.bytes) : await fs.stat(row.filename).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; }))
            throw new Error("synthetic_history_fixture_changed_unexpectedly");
        }
        for (const [original, staged, expected] of [[helper, stagedHelper, helperHash], [sdk, stagedSdk, sdkHash],
          [path.join(path.dirname(sdk), "package.json"), path.join(artifacts, "package.json"), packageArtifact.sha256]])
          if (digest(await fs.readFile(original)) !== expected || digest(await fs.readFile(staged)) !== expected) throw new Error("synthetic_history_artifact_changed");
        await fs.rm(temp, { recursive: true, force: true });
        return { cleanupConfirmed: true, fixturesUnchangedExceptExplicitMutation: true };
      })();
      return closed;
    }
    return Object.freeze({ origin, token, issuedToken, issuedId, peer, cases, helperHash, sdkHash, helperArtifact, sdkArtifact, close,
      setFixturePresent(name, present) {
        const file = files.get(name); if (!file || closed || typeof present !== "boolean") throw new Error("synthetic_fixture_unavailable");
        const next = mutation.then(async () => {
          if (file.present === present) return;
          if (present) await fs.writeFile(file.filename, file.bytes, { mode: 0o600, flag: "wx" }); else await fs.unlink(file.filename);
          file.present = present;
        });
        mutation = next.catch(() => {}); return next;
      },
      changeFixture(name, title = "Synthetic explicit version change") {
        const file = files.get(name), c = cases.find(row => row.name === name); if (!file || !c || !file.present || closed) throw new Error("synthetic_fixture_unavailable");
        if (typeof title !== "string" || !title.length || title.length > 1024 || /[\u0000-\u001f\u007f]/.test(title)) throw new Error("synthetic_title_invalid");
        const extra = encode([{ type: "custom-title", sessionId: c.sessionId, customTitle: title }]);
        const next = mutation.then(async () => { await fs.appendFile(file.filename, extra); file.bytes = Buffer.concat([file.bytes, extra]); });
        mutation = next.catch(() => {}); return next;
      } });
  } catch (error) {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exit; }
    await fs.rm(temp, { recursive: true, force: true }); throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [helperPath, sdkPath] = process.argv.slice(2);
  const host = await startSyntheticHistoryHost({ helperPath, sdkPath });
  console.log(JSON.stringify({ kind: "synthetic_history_host_ready", origin: host.origin, syntheticSignInToken: host.token,
    productionChanged: false, privateHistoryReads: 0, modelCalls: 0 }));
  const input = readline.createInterface({ input: process.stdin }); let ending = false;
  const stop = async () => { if (ending) return; ending = true; input.close(); console.log(JSON.stringify(await host.close())); };
  input.on("line", line => { void (async () => { if (line === "close") await stop(); else if (line.startsWith("change ")) { await host.changeFixture(line.slice(7)); console.log("synthetic_fixture_changed"); } })().catch(() => { process.exitCode = 1; }); });
  input.on("close", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); }); process.once("SIGINT", () => { void stop(); });
}
