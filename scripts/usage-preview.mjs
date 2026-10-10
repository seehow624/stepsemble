#!/usr/bin/env node
// Owned, isolated fixture. All token counts/costs are synthetic; no agent runs.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";
const require = createRequire(import.meta.url), root = fileURLToPath(new URL("../", import.meta.url));
const { createWorkspaceRegistry } = require("../server/workspace-registry");
export async function createUsagePreview(port = 0, { unpriced = false } = {}) {
  const token = "usage-preview-owned-fixture", hosts = [], homes = [], seededAt = Date.now();
  async function host(multiplier, name) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-usage-preview-")); homes.push(home);
    const config = path.join(home, ".config/stepsemble"); await fs.mkdir(config, { recursive: true });
    await fs.writeFile(path.join(config, "token"), token, { mode: 0o600 });
    const registry = createWorkspaceRegistry(path.join(config, "workspaces.json"));
    const now = seededAt, projectOne = path.join(home, "Projects", "Stepsemble"), projectTwo = path.join(home, "Projects", "Website");
    await Promise.all([projectOne, projectTwo].map(dir => fs.mkdir(dir, { recursive: true })));
    const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"];
    const files = [path.join(home, ".codex/sessions/2026/10/11/rollout-2026-10-11-" + ids[0] + ".jsonl"), path.join(home, ".claude/projects/demo/" + ids[1] + ".jsonl"), path.join(home, ".pi/agent/sessions/demo/" + ids[2] + ".jsonl")];
    const rows = [[{ type: "session_meta", payload: { id: ids[0], model_provider: "openai" } }, { type: "turn_context", payload: { model: "gpt-demo", turn_id: "preview-turn" } }], [], [{ type: "session", id: ids[2], cwd: projectTwo }]];
    let input = 0, output = 0, cached = 0;
    for (let day = 29; day >= 0; day--) {
      const at = new Date(now); at.setDate(at.getDate() - day); at.setHours(9 + day % 8, 0, 0, 0);
      if (at.getTime() > now) at.setTime(now);
      const count = (day % 6 + 1) * multiplier, stamp = at.toISOString();
      input += 40000 * count; output += 1700 * count; cached += 31000 * count;
      rows[0].push({ type: "event_msg", timestamp: stamp, payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached, reasoning_output_tokens: 0 }, last_token_usage: { input_tokens: 40000 * count, output_tokens: 1700 * count, cached_input_tokens: 31000 * count } } } });
      rows[1].push({ type: "assistant", sessionId: ids[1], timestamp: stamp, message: { id: `fixture-${multiplier}-${day}`, model: "claude-demo", usage: { input_tokens: 90 * count, output_tokens: 2300 * count, cache_read_input_tokens: 54000 * count, cache_creation_input_tokens: 900 * count } } });
      rows[2].push({ type: "message", id: `pi-${multiplier}-${day}`, timestamp: stamp, message: { role: "assistant", model: "minimax-demo", provider: "minimax", usage: { input: 1200 * count, output: 3700 * count, cacheRead: 19000 * count, cacheWrite: 0, cost: { total: .026 * count } } } });
    }
    for (let i = 0; i < files.length; i++) { await fs.mkdir(path.dirname(files[i]), { recursive: true }); await fs.writeFile(files[i], rows[i].map(row => JSON.stringify(row)).join("\n") + "\n"); }
    registry.remember({ agentId: "codex", id: "codex-history:" + ids[0], nativeHistorySessionId: ids[0], nativeHistoryReadonly: true, name: "Build the usage overview", cwd: projectOne });
    registry.remember({ agentId: "claude-code", id: "claude-history:" + ids[1], nativeHistorySessionId: ids[1], nativeHistoryReadonly: true, name: "Review model costs", cwd: projectOne });
    registry.remember({ agentId: "pi", sid: ids[2], file: "demo/" + ids[2] + ".jsonl", name: "Design the landing page", cwd: projectTwo });
    const models = {
      "gpt-demo": { provider: "openai", input_cost_per_token: .0000025, output_cost_per_token: .00001, cache_read_input_token_cost: .00000025 },
      "claude-demo": { provider: "anthropic", input_cost_per_token: .000003, output_cost_per_token: .000015, cache_read_input_token_cost: .0000003, cache_creation_input_token_cost: .00000375 },
    };
    if (unpriced) delete models["claude-demo"];
    await fs.writeFile(path.join(config, "usage-prices.json"), JSON.stringify({ version: 1, updatedAt: now, models }));
    const serverPort = await freePort();
    const child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: home, stdio: ["ignore", "pipe", "pipe"], env: { ...cleanEnvironment(home), PI_HOME: home, PI_BIN: path.join(home, "no-agent"), PATH: "/usr/bin:/bin", STEPSEMBLE_WORKSPACE_KEYCHAIN_USAGE: "0", STEPSEMBLE_USAGE_PRICING_NETWORK: "0", STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_PORT: String(serverPort), STEPSEMBLE_ORPHAN_EXIT: "0" } });
    child.stderr.on("data", () => {}); child.stdout.resume();
    try { await waitForServer(child, 60000); } catch (error) { await stopServer(child); throw error; }
    return { child, home, name, origin: `http://127.0.0.1:${serverPort}` };
  }
  try { hosts.push(await host(1, "Mac Mini")); hosts.push(await host(2, "MacBook Pro")); }
  catch (error) { for (const host of hosts) await stopServer(host.child); for (const home of homes) await fs.rm(home, { recursive: true, force: true }); throw error; }
  let offline = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1"), remote = url.pathname.startsWith("/r/mbp/"), target = hosts[remote ? 1 : 0], route = remote ? url.pathname.slice(6) : url.pathname;
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const authenticated = String(req.headers.cookie || "").split(";").some(cookie => [token, hash].some(value => cookie.trim() === "stepsemble=" + value));
    const json = (status, value) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
    if (authenticated && route === "/api/machines") return json(200, { current: "mini", machines: [{ id: "mini", name: "Mac Mini", self: true }, { id: "mbp", name: "MacBook Pro", self: false }] });
    if (remote && offline) return json(503, { error: "synthetic_host_offline" });
    if (authenticated && route === "/api/workspace/usage") return json(200, { updatedAt: Date.now(), providers: [{ provider: "Codex", status: "ready", windows: [{ remainingPercent: remote ? 38 : 72, windowDurationMins: 300, resetsAt: Date.now() + 7200000 }] }, { provider: "Claude", status: "ready", windows: [{ remainingPercent: 62, windowDurationMins: 10080, resetsAt: Date.now() + 86400000 }] }] });
    const headers = { ...req.headers, host: new URL(target.origin).host }; delete headers.origin;
    const proxy = http.request(target.origin + route + url.search, { method: req.method, headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    proxy.on("error", () => { if (!res.headersSent) json(502, { error: "preview_unavailable" }); else res.destroy(); }); req.pipe(proxy);
  });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  let closing = null;
  const close = () => closing ||= (async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await Promise.all(hosts.map(host => stopServer(host.child))); await Promise.all(homes.map(home => fs.rm(home, { recursive: true, force: true }))); })();
  return { origin: `http://127.0.0.1:${server.address().port}`, token, hosts, setOffline(value) { offline = value; }, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const preview = await createUsagePreview(Number(process.argv[2] || 0));
  console.log(JSON.stringify({ url: preview.origin, token: preview.token, pid: process.pid, syntheticOnly: true, modelCalls: 0 }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => preview.close().finally(() => process.exit()));
}
