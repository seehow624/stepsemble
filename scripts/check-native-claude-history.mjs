#!/usr/bin/env node
// Test-only official SDK readback. Never calls query(), startup(), resume or auth.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import fixture from "../protocol/native/claude/history-fixture.cjs";
const exec = promisify(execFile), self = fileURLToPath(import.meta.url);
const fixturePath = fileURLToPath(new URL("../protocol/native/claude/history-fixture.cjs", import.meta.url));
export const SDK_VERSION = "0.3.259", NATIVE_VERSION = "2.1.259";
export const SDK_SHA256 = "7fa7c212361864544e775e7551519e790515f95d4bb6a4831b0b05f5b368a0c5";
export const SDK_INTEGRITY = "sha512-5VJSzHQTAPFl2BytZSgyL0Xtdi3I7CeajEhO4KTvm6bx4nt1OIp+IHx78MuurA4Pp/t9UEPa3cWz8Q55Pi9MYw==";
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
export function environment(home) {
  const value = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
    PATH: path.dirname(process.execPath) };
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"])
    if (process.env[key]) value[key] = process.env[key];
  return value;
}
export async function worker(sdk, home) {
  // Runtime-enforced canaries: this subprocess cannot start a CLI or write files.
  await assert.rejects(async () => exec(process.execPath, ["--version"]), { code: "ERR_ACCESS_DENIED" });
  await assert.rejects(async () => fs.writeFile(path.join(home, "must-not-write"), "x"), { code: "ERR_ACCESS_DENIED" });
  const { getSessionMessages, getSessionInfo } = await import(pathToFileURL(sdk).href);
  const cwd = path.join(home, "workspace"), options = { dir: cwd };
  const rows = await getSessionMessages(fixture.sessionId, options);
  assert.deepEqual(rows.map(row => row.uuid), fixture.expectedIds);
  assert.deepEqual(rows.map(row => row.type), ["user", "assistant", "user", "assistant", "assistant"]);
  assert.ok(rows.every(row => row.session_id === fixture.sessionId && row.parent_tool_use_id === null && row.parent_agent_id === null));
  assert.equal(rows[0].message.content, "第一個問題 🐾");
  assert.equal(rows[3].message.id, rows[4].message.id);
  assert.notEqual(rows[3].uuid, rows[4].uuid); // API message id is not the history-row identity.
  const first = await getSessionMessages(fixture.sessionId, { ...options, offset: 0, limit: 2 });
  const second = await getSessionMessages(fixture.sessionId, { ...options, offset: 2, limit: 3 });
  assert.deepEqual([...first, ...second], rows);
  assert.deepEqual(await getSessionMessages(fixture.sessionId, { ...options, offset: 5, limit: 2 }), []);
  assert.deepEqual(await getSessionMessages(fixture.otherSessionId, options), []);
  assert.deepEqual(await getSessionMessages("../not-a-session", options), []);
  const info = await getSessionInfo(fixture.sessionId, options);
  assert.equal(info.sessionId, fixture.sessionId); assert.equal(info.customTitle, "Synthetic native title");
  return { sdkVersion: SDK_VERSION, nativeVersion: NATIVE_VERSION, result: "passed", source: "synthetic-jsonl",
    selectedMessageCount: rows.length, branchOrderVerified: true, unicodePreserved: true, messageUuidDistinctFromApiId: true,
    paginationVerified: true, titleReadbackVerified: true, missingSessionReturnsEmpty: true,
    childProcessPermissionDenied: true, fileWritePermissionDenied: true, modelCalls: 0, approvalExercised: false };
}
export async function capture(suppliedSdk) {
  assert.ok(path.isAbsolute(suppliedSdk), "Supply the absolute official SDK module path");
  const sdk = await fs.realpath(suppliedSdk), sdkDir = path.dirname(sdk);
  assert.equal(path.basename(sdk), "sdk.mjs");
  const pkg = JSON.parse(await fs.readFile(path.join(sdkDir, "package.json"), "utf8"));
  assert.equal(pkg.name, "@anthropic-ai/claude-agent-sdk"); assert.equal(pkg.version, SDK_VERSION); assert.equal(pkg.claudeCodeVersion, NATIVE_VERSION);
  const sdkSha256 = digest(await fs.readFile(sdk));
  assert.equal(sdkSha256, SDK_SHA256, "Review SDK source drift before running the history contract");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-claude-history-fixture-"));
  try {
    const cwd = path.join(home, "workspace"); await fs.mkdir(cwd);
    const realCwd = await fs.realpath(cwd), projectKey = realCwd.replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = path.join(home, ".claude/projects", projectKey); await fs.mkdir(projectDir, { recursive: true });
    const filename = path.join(projectDir, `${fixture.sessionId}.jsonl`);
    const bytes = fixture.fixture(realCwd).map(row => JSON.stringify(row)).join("\n") + "\n";
    await fs.writeFile(filename, bytes, { mode: 0o600 });
    // No allow-child-process, allow-fs-write, allow-worker or real HOME access.
    const args = ["--permission", ...[sdkDir, self, fixturePath, home].map(dir => `--allow-fs-read=${dir}`), self, "--worker", sdk, home];
    const result = await exec(process.execPath, args, { cwd: home, env: environment(home), timeout: 30000, maxBuffer: 65536 });
    const report = JSON.parse(result.stdout);
    assert.equal(await fs.readFile(filename, "utf8"), bytes);
    assert.equal(digest(await fs.readFile(sdk)), sdkSha256);
    return { ...report, nativeFileUnchanged: true, sdkSha256, scope: "Offline read-only SDK history contract; no CLI/model/auth, live approval, reconnect or durable-store verification" };
  } finally { await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
export async function downloadCapture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-claude-history-sdk-"));
  try {
    // Fetch one public integrity-pinned artifact, not a floating npm dependency
    // tree. Extract only the bundled JS and metadata; no native CLI is installed.
    const response = await fetch(`https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-${SDK_VERSION}.tgz`,
      { redirect: "error", signal: AbortSignal.timeout(30000) });
    assert.ok(response.ok && response.body, "Pinned SDK download unavailable");
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > 16 * 1024 * 1024) { await reader.cancel(); throw new Error("SDK archive exceeds limit"); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    assert.equal("sha512-" + crypto.createHash("sha512").update(bytes).digest("base64"), SDK_INTEGRITY);
    const archive = path.join(temp, "sdk.tgz"); await fs.writeFile(archive, bytes);
    // Exact regular members of this verified artifact; no package scripts run.
    const tarEnv = environment(temp);
    tarEnv.PATH = process.platform === "win32" ? path.join(process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows", "System32") : "/usr/bin:/bin";
    await exec("tar", ["-xzf", archive, "-C", temp, "package/sdk.mjs", "package/package.json"], { env: tarEnv, timeout: 10000, maxBuffer: 65536 });
    return await capture(path.join(temp, "package/sdk.mjs"));
  } finally { await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args[0] === "--worker" && args.length === 3) console.log(JSON.stringify(await worker(args[1], args[2])));
  else if (args.length === 1) console.log(JSON.stringify(await (args[0] === "--download" ? downloadCapture() : capture(args[0])), null, 2));
  else throw new Error("Usage: check-native-claude-history.mjs /absolute/official-sdk/sdk.mjs");
}
