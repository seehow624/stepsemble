#!/usr/bin/env node
// Actual Host/UI with owned synthetic records only. No native CLI is launched.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-agent-icons-"));
let child, closing = false;
async function close() {
  if (closing) return; closing = true;
  if (child) await stopServer(child);
  await fs.rm(temp, { recursive: true, force: true });
}
process.once("SIGINT", () => close().then(() => process.exit()));
process.once("SIGTERM", () => close().then(() => process.exit()));
try {
  const config = path.join(temp, ".config/stepsemble"), cwd = path.join(temp, "Projects", "Design workspace");
  const folder = path.join(temp, ".pi/agent/sessions/synthetic");
  await Promise.all([config, cwd, folder].map(dir => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
  const timestamp = new Date().toISOString(), now = Date.now();
  await fs.writeFile(path.join(folder, "synthetic.jsonl"), [
    { type: "session", id: "synthetic", cwd, timestamp },
    { type: "session_info", name: "整理介面與貓掌標誌", timestamp },
    { type: "message", id: "u1", timestamp, message: { role: "user", content: [{ type: "text", text: "整理介面與貓掌標誌" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp, message: { role: "assistant", content: [{ type: "text", text: "這是隔離的介面範例，不含私人對話。" }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  if (process.argv.includes("--catalog-stress")) {
    for (let i = 0; i < 125; i++) {
      const id = `catalog-${String(i).padStart(3, "0")}`;
      await fs.writeFile(path.join(folder, `${id}.jsonl`), [
        { type: "session", id, cwd, timestamp },
        { type: "session_info", name: `合成對話 ${String(i).padStart(3, "0")} · 不同來源保留同名`, timestamp },
        { type: "message", id: "u1", timestamp, message: { role: "user", content: [{ type: "text", text: "Synthetic catalog pagination" }] } },
      ].map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
    }
  }
  const names = ["檢查登入流程與錯誤提示", "調整手機版對話列表", "整理模型設定與工具", "研究專案結構", "新來源的中性圖示"];
  const tasks = ["claude-code", "codex", "opencode", "grok-build", "unknown-source"].map((agentId, index) => ({
    id: `synthetic-icon-${index}`, agentId, name: names[index], cwd, status: "completed",
    startedAt: now - 180000 - index * 1000, endedAt: now - 120000 - index * 1000, lastActivityAt: now - index * 1000,
    outputTail: "Synthetic preview only. No model or account was used.", exitCode: 0, settledNotified: true,
  }));
  await fs.writeFile(path.join(config, "agent-tasks.json"), JSON.stringify({ tasks }), { mode: 0o600 });
  const port = await freePort();
  child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: temp, stdio: ["ignore", "pipe", "pipe"],
    env: { HOME: temp, PI_HOME: temp, PI_BIN: path.join(temp, "no-native-pi"), LANG: "en_US.UTF-8",
      PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin:/bin`,
      STEPSEMBLE_TOKEN: "synthetic-agent-icons-only", STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_PORT: String(port), STEPSEMBLE_ORPHAN_EXIT: "0" } });
  await waitForServer(child); child.stdout.resume(); child.stderr.resume();
  console.log(JSON.stringify({ origin: `http://127.0.0.1:${port}`, syntheticSignInToken: "synthetic-agent-icons-only", nativeCalls: 0 }));
  await new Promise(resolve => child.once("exit", resolve));
} finally { await close(); }
