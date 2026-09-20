// Real installed Pi, isolated home, fake key, zero model inference.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-model-sync-"));
const dir = path.join(home, ".pi", "agent");
fs.mkdirSync(dir, { recursive: true });
function config(models) {
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: {
    "catalog-fixture": { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "not-a-real-key", models },
  } }));
}
config([{ id: "old", name: "Old name" }]);
const child = spawn(process.env.PI_BIN || "pi", ["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
  "--extension", path.join(root, "server", "pi-catalog-extension.mjs")], {
  cwd: home, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1" }, stdio: ["pipe", "pipe", "pipe"],
});
const pending = new Map(); let seq = 0, buffer = "", stderr = "", messages = 0;
const closed = new Promise(resolve => child.on("close", resolve));
child.stderr.on("data", c => { stderr = (stderr + c).slice(-2000); });
child.stdout.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf("\n"); if (nl < 0) break;
    const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "message_start") messages++;
    const wait = pending.get(event.id);
    if (wait && event.type === "response") { pending.delete(event.id); wait.resolve(event); }
  }
});
child.on("error", error => { for (const wait of pending.values()) wait.reject(error); });
child.on("exit", () => { for (const wait of pending.values()) wait.reject(new Error(`Pi exited: ${stderr}`)); });
async function command(type, fields = {}) {
  const id = `probe-${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${type}`)); }, 20000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ type, id, ...fields }) + "\n");
  });
}
try {
  const commands = await command("get_commands");
  assert(commands.data.commands.some(c => c.name === "stepsemble-refresh-models"), "extension registered");
  const before = await command("get_available_models");
  assert(before.data.models.some(m => m.id === "old"));
  config([{ id: "new", name: "New model" }]);
  const stale = await command("get_available_models");
  assert(stale.data.models.some(m => m.id === "old"), "reproduced stale native snapshot");
  const reload = await command("prompt", { message: "/stepsemble-refresh-models" });
  assert.equal(reload.success, true);
  const after = await command("get_available_models");
  assert(after.data.models.some(m => m.id === "new"));
  assert(!after.data.models.some(m => m.id === "old"));
  const selected = await command("set_model", { provider: "catalog-fixture", modelId: "new" });
  assert.equal(selected.success, true);
  const state = await command("get_state");
  assert.equal(state.data.messageCount, 0);
  assert.equal(messages, 0);
  console.log(JSON.stringify({ ok: true, reproducedStaleSnapshot: true, reloaded: true, newModelSelectable: true, modelCalls: 0 }));
} finally {
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  await closed; clearTimeout(timer);
  fs.rmSync(home, { recursive: true, force: true });
}
