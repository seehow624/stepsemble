#!/usr/bin/env node
// Explicit macOS real GUI-context / synthetic CLI gate. No native account,
// model, login, logout, production Host restart or production state reads.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { launchAgentPlist } from "./install-claude-desktop.mjs";
import { desktopPaths } from "../server/claude-desktop-state.js";
import { createDesktopClaudeClient } from "../server/claude-desktop-client.js";
import { createAgentTaskService } from "../server/agent-connectors.js";
import { launchClaudeStructuredSession } from "../server/claude-structured-launch.js";

if (process.platform !== "darwin" || process.argv[2] !== "--offline") throw new Error("Explicit macOS --offline gate only");
const run = promisify(execFile), source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-desktop-gui-"));
const home = os.homedir(), configDir = path.join(temp, "config"), project = path.join(temp, "project"), bin = path.join(temp, "bin");
const paths = desktopPaths(configDir), label = `com.stepsemble.test-desktop-${crypto.randomUUID()}`, serviceTarget = `gui/${process.getuid()}/${label}`;
let bootstrapped = false, service, first, client, task, structured, failed = false;
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(predicate, limit = 80) { for (let n = 0; n < limit; n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error("bounded GUI fixture deadline"); }
try {
  for (const directory of [configDir, paths.directory, project, bin]) await fs.mkdir(directory, { mode: 0o700 });
  const runtime = path.join(temp, "runtime");
  await fs.cp(path.join(source, "server"), path.join(runtime, "server"), { recursive: true });
  await fs.cp(path.join(source, "protocol"), path.join(runtime, "protocol"), { recursive: true });
  await fs.cp(path.join(source, "public", "modules"), path.join(runtime, "public", "modules"), { recursive: true });
  await run(process.execPath, ["-e", "require(process.argv[1])", path.join(runtime, "server", "claude-desktop-helper.js")], { timeout: 5000 });
  const peer = path.join(temp, "peer.cjs"), command = path.join(bin, "claude");
  await fs.copyFile(path.join(source, "test-support", "desktop-claude-peer.cjs"), peer);
  await fs.copyFile(path.join(source, "test-support", "desktop-claude-structured-peer.cjs"), path.join(temp, "desktop-claude-structured-peer.cjs"));
  await fs.writeFile(command, `#!/bin/sh\nexport DESKTOP_FIXTURE_HOME="${temp}"\nexport DESKTOP_FIXTURE_CONTEXT=gui-probe\nexport DESKTOP_FIXTURE_CHECK_CONTEXT=1\nexec "${process.execPath}" "${peer}" "$@"\n`, { mode: 0o700 });
  await fs.writeFile(paths.key, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const configFile = path.join(paths.directory, "config.json");
  await fs.writeFile(configFile, JSON.stringify({ version: 1, home, configDir, claudeCommand: command, roots: [project] }), { mode: 0o600 });
  const plist = path.join(temp, "agent.plist"), searchPath = [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":");
  await fs.writeFile(plist, launchAgentPlist({ node: process.execPath, entry: path.join(runtime, "server", "claude-desktop-entry.js"), config: configFile, home, searchPath, serviceLabel: label }), { mode: 0o600 });
  await run("/usr/bin/plutil", ["-lint", plist], { timeout: 3000 });
  await run("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, plist], { timeout: 5000 }); bootstrapped = true;
  client = createDesktopClaudeClient({ configDir, timeoutMs: 12000 });
  await until(async () => (await client.health().catch(() => null))?.context === "Aqua");
  const status = await client.status(); assert.equal(status.credential.state, "detected"); assert.equal(status.credential.liveVerified, false);
  // Exercise the production native route from a synthetic SSH environment.
  // The broker must preserve native controls while the actual child lives in
  // Aqua, exactly like the credential metadata check above.
  assert.equal((await client.health()).structuredStreamVersion, 1);
  structured = await launchClaudeStructuredSession({ desktopClient: client, command, cwd: project,
    env: { HOME: "/invalid-ssh-home", SSH_CONNECTION: "synthetic-background-side" }, permissionPrompts: "host" });
  assert.equal((await structured.models()).currentModel, "sonnet");
  assert.equal((await structured.setModel("opus")).model, "opus");
  assert.equal((await structured.setModel("sonnet")).model, "sonnet");
  assert.equal((await client.health()).activeStructured, 1);
  assert.equal((await client.status()).canStart, false);
  assert.equal((await structured.send("approve desktop bridge")).kind, "sent");
  await until(() => structured.status().eventCount >= 4 && structured.contextUsage().contextWindow === 200000);
  assert.equal(structured.contextUsage().contextTokens, 12);
  assert.equal((await structured.acknowledgePermission("perm-fixture", "deny")).kind, "written");
  await structured.close();
  assert.equal(structured.status().cleanupConfirmed, true);
  await until(async () => (await client.health()).activeStructured === 0);
  const options = { appHome: home, configDir, env: { HOME: home, PATH: searchPath, SSH_CONNECTION: "synthetic-background-side" }, desktopClaude: client, validateCwd: cwd => cwd === project ? project : null };
  first = createAgentTaskService(options); service = first;
  task = await service.open({ agentId: "claude-code", cwd: project, name: "Offline GUI context fixture" });
  await until(() => service.get(task.id).outputTail.includes("desktop-fixture-ready:gui-probe"));
  service.shutdown({ preserve: true });
  // Respect the installed agent's 30 s crash-loop throttle; a 5 s command
  // deadline incorrectly classified launchd's deliberate delay as failure.
  await run("/bin/launchctl", ["kickstart", "-k", serviceTarget], { timeout: 45000 });
  await until(async () => (await client.health().catch(() => null))?.context === "Aqua");
  service = createAgentTaskService(options);
  await until(() => service.get(task.id)?.control?.writable);
  service.send(task.id, "fixture-exit");
  await until(() => !alive(service.get(task.id).supervisorPid));
  const contexts = (await fs.readFile(path.join(temp, "contexts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(contexts.some(row => row.kind === "metadata")); assert.ok(contexts.some(row => row.kind === "task")); assert.ok(contexts.some(row => row.kind === "structured"));
  assert.ok(contexts.every(row => row.context === "Aqua"));
  assert.equal((await fs.readFile(path.join(temp, "task-attempts"), "utf8")).trim(), "attempt");
  assert.equal(await fs.readFile(path.join(temp, "auth-attempts"), "utf8").catch(() => ""), "");
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, helperContext: "Aqua", metadataContext: "Aqua", taskContext: "Aqua", structuredContext: "Aqua", structuredControls: true, structuredCleanup: true, launches: 1, helperRestartReattach: true, hostRestartReattach: true, nativeAccountCalls: 0, loginCalls: 0, modelCalls: 0 }));
} catch (error) { failed = true; console.error("Offline desktop context gate failed:", error.message); process.exitCode = 1; }
finally {
  await structured?.close().catch(() => { failed = true; process.exitCode = 1; });
  const owned = task && service ? [service.get(task.id)?.pid, service.get(task.id)?.supervisorPid].filter(Boolean) : [];
  service?.shutdown(); if (first && first !== service) first.shutdown({ preserve: true });
  client?.close();
  await until(() => owned.every(pid => !alive(pid))).catch(() => { failed = true; process.exitCode = 1; });
  if (bootstrapped) await run("/bin/launchctl", ["bootout", serviceTarget], { timeout: 5000 }).catch(() => { failed = true; process.exitCode = 1; });
  if (!failed) await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  else console.log(`Owned diagnostic files retained: ${temp}`);
}
