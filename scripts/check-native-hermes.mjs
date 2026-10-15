#!/usr/bin/env node
// Read-only check of the real Hermes on this computer, with the sign-in the
// assistant page saved (sign in there first). It reads the status, the Bots,
// recent conversations, routines and group support, and prints only counts
// and versions: no messages are sent, nothing is changed, and no conversation
// text or names are printed.
//   node scripts/check-native-hermes.mjs
// Exit 0 when every read worked, 2 when one failed, 1 when it could not start.
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createHermesDiscovery } = require("../server/hermes-discovery");
const { createHermesSessionStore } = require("../server/hermes-session-store");
const { createHermesGatewayClient } = require("../server/hermes-gateway-client");

const configDir = process.env.STEPSEMBLE_CONFIG_DIR || path.join(os.homedir(), ".config", "stepsemble");
const client = createHermesGatewayClient({
  discovery: createHermesDiscovery(),
  store: createHermesSessionStore({ file: path.join(configDir, "hermes-session.json") }),
});
const report = { agent: "hermes", checks: {} };
const done = code => { client.close(); console.log(JSON.stringify(report, null, 2)); process.exit(code); };

const status = await client.status();
report.version = status.version;
if (!status.running) { report.error = "Hermes is not running on this computer"; done(1); }
if (!status.signedIn) { report.error = "Sign in to Hermes on the Stepsemble assistant page first"; done(1); }

async function check(name, read) {
  try { report.checks[name] = { ok: true, ...(await read()) }; } catch (error) { report.checks[name] = { ok: false, error: String(error?.code || error?.message || error) }; }
}
await check("profiles.list", async () => {
  const result = await client.request("profiles.list", { include_sessions: true }, { timeoutMs: 30_000 });
  const rows = Array.isArray(result?.profiles) ? result.profiles : [];
  return { bots: rows.length, withBotChat: rows.filter(row => row?.canonical_session).length, botModeProtocol: result?.bot_mode_protocol === true };
});
await check("sessions", async () => ({ recent: (await client.rest("GET", "/api/sessions", { query: { order: "recent", limit: 5 } }))?.sessions?.length ?? 0 }));
await check("routines", async () => {
  const jobs = await client.rest("GET", "/api/cron/jobs", { query: { profile: "all" } });
  return { routines: Array.isArray(jobs) ? jobs.length : Array.isArray(jobs?.jobs) ? jobs.jobs.length : 0 };
});
await check("groups.capabilities", async () => ({ driver: (await client.request("groups.capabilities", {}, { timeoutMs: 15_000 }))?.driver === true }));
done(Object.values(report.checks).every(item => item.ok) ? 0 : 2);
