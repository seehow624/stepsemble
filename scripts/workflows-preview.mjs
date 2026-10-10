#!/usr/bin/env node
// Synthetic design review only. No workflow is actually executed.
import { createNativeComposerPreview } from "./native-composer-preview.mjs";
import workflowService from "../server/workflows.js";
const now = Date.now(), limits = { minutes: 60, turns: 20, outputTokens: 100000 };
const base = { mode: "goal", cwd: "/tmp/stepsemble-demo/Website", limits, createdAt: now - 7200000, updatedAt: now };
const runs = [
  { ...base, id: "design-goal-1", title: "讓新首頁準備好上線", objective: "完成首頁的手機版排版，確認鍵盤操作與載入速度，修復問題後跑完回歸檢查。", agentId: "pi", status: "running", elapsedMs: 754000, turns: 4, outputTokens: 18240, activity: "正在檢查手機版導覽與鍵盤焦點，接著驗證首頁效能。", result: "首頁版面已完成。正在驗證小螢幕上的導覽行為與無障礙操作。" },
  { ...base, id: "design-goal-2", title: "整理 API 文件與範例", objective: "補齊公開 API 的使用範例，確認每個範例都能執行。", cwd: "/tmp/stepsemble-demo/API", agentId: "codex", status: "blocked", elapsedMs: 383000, turns: 2, outputTokens: 9100, activity: "需要確認正式環境的 API 版本。", result: "草稿與本機驗證已完成。請確認要對應 v1 還是 v2。" },
  { ...base, id: "design-goal-3", title: "修復登入後的返回行為", objective: "登入成功後返回原本頁面，並補上回歸測試。", agentId: "claude-code", status: "completed", elapsedMs: 287000, turns: 3, outputTokens: 12100, activity: "completed", result: "已修復登入後的返回路徑，6 項回歸檢查全部通過。" },
  { ...base, id: "design-goal-4", title: "改善設定頁面文案", objective: "讓設定說明更清楚，並補齊所有語言。", agentId: "pi", status: "paused", elapsedMs: 92000, turns: 1, outputTokens: 2400, activity: "paused", result: "已整理文案，等待繼續。" },
  { ...base, id: "design-run-1", scheduleId: "design-schedule-1", title: "每天的專案健康檢查", objective: "檢查測試、依賴與待處理問題，整理一份簡短報告。", agentId: "codex", mode: "task", status: "completed", elapsedMs: 173000, turns: 1, outputTokens: 6700, result: "所有測試通過。沒有新的高風險依賴問題，兩個待辦項目已整理。", createdAt: now - 86400000, startedAt: now - 86400000 },
];
const schedules = [
  { ...base, id: "design-schedule-1", title: "每天的專案健康檢查", objective: "檢查測試、依賴與待處理問題，整理一份簡短報告。", agentId: "codex", mode: "task", enabled: true, schedule: { kind: "daily", time: "09:00", timeZone: "Asia/Kuala_Lumpur" }, nextAt: now + 7200000, lastRunId: "design-run-1" },
  { ...base, id: "design-schedule-2", title: "工作日整理開發進度", objective: "彙整本週完成項目，指出下一步需要處理的問題。", agentId: "pi", mode: "task", enabled: true, schedule: { kind: "weekly", time: "18:00", timeZone: "Asia/Kuala_Lumpur", days: [1,2,3,4,5] }, nextAt: now + 172800000 },
  { ...base, id: "design-schedule-3", title: "檢查預覽站是否正常", objective: "確認預覽站能開啟，並整理出現的錯誤。", agentId: "claude-code", mode: "task", enabled: false, schedule: { kind: "interval", minutes: 120 }, nextAt: now + 3600000 },
];
for (const row of schedules) {
  row.schedule = workflowService.scheduleSpec(row.schedule, now);
  row.nextAt = workflowService.nextOccurrence(row.schedule, now);
}
const preview = await createNativeComposerPreview({ port: Number(process.argv[2] || 0), workflows: { runs, schedules } });
console.log(JSON.stringify({ url: preview.origin, token: preview.token, syntheticOnly: true, modelCalls: 0 }));
let closing = false;
async function close() { if (closing) return; closing = true; await preview.close(); }
process.on("SIGTERM", close); process.on("SIGINT", close);
