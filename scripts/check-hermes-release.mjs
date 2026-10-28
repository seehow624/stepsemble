#!/usr/bin/env node
// Checks a Hermes release against what the assistant page relies on, once
// per release. Hermes is installed from its git repository, not a package
// registry, so this reads a Hermes source checkout (by default the local
// ~/.hermes/hermes-agent) and confirms every JSON-RPC method and REST route
// Stepsemble calls is still there. Nothing is run and Hermes is not contacted.
// The verdict is kept in ~/.config/stepsemble/hermes-release-checks.json.
//   node scripts/check-hermes-release.mjs [--source <dir>] [--tag v0.22.1] [--force]
// --tag reads that release from the checkout's git history (it must have been
// fetched), so a release can be checked before Hermes is updated to it.
// Prints one JSON object. action "none": the release passed (now or before);
// "adapt": something Stepsemble uses is missing. Exit 0 when it passed, 2 when
// it failed, 1 when it could not be checked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readRecords, recordFileFor, writeRecord } from "./agent-release-lib.mjs";

// Methods on Hermes's /api/ws JSON-RPC socket.
export const HERMES_METHODS = [
  "client.capabilities", "profiles.list", "profiles.describe", "profiles.configure", "profiles.create", "profiles.set_asset", "profiles.get_asset",
  "session.list", "session.create", "session.title", "session.resume", "session.events.since", "session.interrupt", "session.steer", "prompt.submit",
  "image.attach_bytes", "file.attach", "model.options", "config.get", "config.set",
  "groups.capabilities", "groups.list", "groups.create", "groups.send", "groups.log", "groups.state", "groups.stop", "groups.approve",
  "groups.retry", "groups.rename", "groups.disband",
];
// Routes of Hermes's web server, as they are declared in its source.
export const HERMES_ROUTES = [
  "/api/status", "/auth/password-login", "/api/auth/ws-ticket", "/api/sessions", "/api/sessions/search", "/api/sessions/{session_id}",
  "/api/cron/jobs", "/api/cron/jobs/{job_id}", "/api/cron/jobs/{job_id}/pause", "/api/cron/jobs/{job_id}/resume", "/api/cron/delivery-targets",
  "/api/profiles/{name}", "/api/skills", "/api/skills/toggle", "/api/skills/content", "/api/skills/hub/search", "/api/skills/hub/preview",
  "/api/skills/hub/scan", "/api/skills/hub/install", "/api/skills/hub/uninstall", "/api/actions/{name}/status",
  "/api/config", "/api/model/auxiliary", "/api/model/set", "/api/env", "/api/providers/custom-endpoints",
  "/api/providers/custom-endpoints/{endpoint_id}", "/api/providers/custom-endpoints/{endpoint_id}/activate", "/api/analytics/usage", "/api/gateway/restart",
];

function pythonFiles(directory) {
  const files = [];
  const walk = folder => {
    let entries = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === "__pycache__" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".py")) files.push(full);
    }
  };
  walk(directory);
  return files;
}

// Which of the methods and routes the source no longer declares.
export function checkSource(source) {
  const gateway = path.join(source, "tui_gateway"), web = path.join(source, "hermes_cli");
  if (!fs.existsSync(gateway) || !fs.existsSync(web)) throw new Error(`${source} is not a Hermes source checkout`);
  const read = folder => pythonFiles(folder).map(file => fs.readFileSync(file, "utf8")).join("\n");
  const gatewayText = read(gateway), webText = read(web);
  return {
    missingMethods: HERMES_METHODS.filter(name => !gatewayText.includes(`"${name}"`)),
    missingRoutes: HERMES_ROUTES.filter(route => !new RegExp(`["']${route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(webText)),
  };
}

function versionOf(source) {
  try { return execFileSync("git", ["-C", source, "describe", "--tags", "--abbrev=0"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().replace(/^v/, ""); }
  catch { return "unknown"; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const at = args.indexOf("--source");
  const checkout = at >= 0 ? args[at + 1] : process.env.STEPSEMBLE_HERMES_SOURCE || path.join(os.homedir(), ".hermes", "hermes-agent");
  const tagAt = args.indexOf("--tag");
  const tag = tagAt >= 0 ? args[tagAt + 1] : null;
  let source = checkout, scratch = null;
  if (tag) {
    if (!/^v?\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(tag)) { console.log(JSON.stringify({ agent: "hermes", action: "unknown", error: "--tag takes a release such as v0.22.1" })); process.exit(1); }
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-hermes-release-"));
    try {
      const archive = path.join(scratch, "release.tar");
      execFileSync("git", ["-C", checkout, "archive", "--format=tar", "-o", archive, tag.startsWith("v") ? tag : `v${tag}`, "tui_gateway", "hermes_cli"], { stdio: "ignore" });
      execFileSync("tar", ["-xf", archive, "-C", scratch], { stdio: "ignore" });
      source = scratch;
    } catch {
      fs.rmSync(scratch, { recursive: true, force: true });
      console.log(JSON.stringify({ agent: "hermes", action: "unknown", error: `${tag} is not in ${checkout}; fetch Hermes's tags first` }));
      process.exit(1);
    }
  }
  const recordFile = process.env.STEPSEMBLE_HERMES_RELEASE_CHECKS || recordFileFor("hermes");
  const finish = (code, report) => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); console.log(JSON.stringify(report, null, 2)); process.exit(code); };
  if (!source || !fs.existsSync(source)) finish(1, { agent: "hermes", action: "unknown", error: `No Hermes source at ${source}` });
  const version = tag ? tag.replace(/^v/, "") : versionOf(source);
  const previous = readRecords(recordFile)[version];
  if (!force && version !== "unknown" && previous?.passed === true) finish(0, { agent: "hermes", version, action: "none", cached: true, checkedAt: previous.checkedAt });
  let result;
  try { result = checkSource(source); } catch (error) { finish(1, { agent: "hermes", version, action: "unknown", error: error.message }); }
  const passed = !result.missingMethods.length && !result.missingRoutes.length;
  const checkedAt = new Date().toISOString();
  if (version !== "unknown") writeRecord(recordFile, version, { passed, checkedAt, ...result });
  finish(passed ? 0 : 2, { agent: "hermes", version, action: passed ? "none" : "adapt", checkedAt, ...result });
}
