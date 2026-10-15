# Hermes 助理 第 2 階段（例行工作）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每個 Bot 頁面新增「例行工作」分頁，名單頁有「所有例行工作」總覽：查看排程、下次執行、上次結果；暫停／繼續、立即執行（兩段確認）、執行紀錄（可打開該次對話）、編輯、刪除（兩段確認）、新增；每項可逐一開關「同時送到這個 Bot 的對話」。

**Architecture:** 例行工作就是該 Bot profile 的 Hermes cron job。新模組 `server/hermes-routines.js` 只透過 Hermes 的 `/api/cron/*` REST 讀寫，不存任何資料；路由掛在既有的 `/api/assistant/routines*`（只用 GET／POST）。前端新增 `public/modules/assistant-routines.js`，排程選擇器與送達清單的轉換放在 `assistant-model.js`（純函式，Node 測試）。

**Tech Stack:** 同第 1 階段。

**Hermes 0.21.6 事實（已讀原始碼確認）：**
- `GET /api/cron/jobs?profile=<name|all>` 回傳 job 陣列；`POST /api/cron/jobs?profile=` 建立（`name, schedule, prompt, deliver, skills, model, provider, paused…`）；`PUT /api/cron/jobs/{id}?profile=` 的 body 是 `{updates: {...}}`；`POST …/{id}/pause|resume|trigger`；`DELETE …/{id}`；`GET …/{id}/runs?limit=` 回 `{runs}`；`GET /api/cron/delivery-targets?profile=` 回 `{targets: [{id, name, home_target_set}]}`。
- job 欄位：`id, name, prompt, schedule{kind, expr|minutes|run_at, display}, schedule_display, enabled, state, next_run_at, last_run_at, last_status, last_error, last_delivery_error, deliver, model, provider, skills, no_agent, script`。
- 排程字串：cron（`0 9 * * 1-5`）、`every 30m`／`every 2h`、ISO 時間（一次）。送達：逗號分隔，`bot-chat` 是這個 Bot 的永久對話。
- Bot Mode 建立的例行工作命名為 `[bot:<profile>] <名稱>`。

---

## 檔案結構

| 檔案 | 動作 | 職責 |
|---|---|---|
| `test-support/fake-hermes-gateway.cjs` | 修改 | 加上 cron REST |
| `public/modules/assistant-model.js` | 修改 | 排程選擇器 ↔ 排程字串、送達清單、去掉名稱前綴 |
| `server/hermes-routines.js` | 新增 | 例行工作的讀寫與驗證 |
| `server/hermes-assistant-routes.js` | 修改 | `/api/assistant/routines*` |
| `server.js` | 修改 | 建立 routines 並交給路由 |
| `public/modules/assistant-i18n.js` | 修改 | 例行工作字串（11 種語言） |
| `public/modules/assistant-api.js` | 修改 | routines 呼叫 |
| `public/modules/assistant-routines.js` | 新增 | 例行工作畫面 |
| `public/modules/assistant.js`、`assistant.css`、`public/assistant.html` | 修改 | 分頁、總覽入口、樣式、載入模組 |
| `scripts/assistant-browser-cases.mjs` | 修改 | 例行工作的瀏覽器測試 |
| `package.json`、`docs/hermes-assistant.md` | 修改 | 檢查腳本、文件 |
| 測試：`test/hermes-routines.test.js`、`test/assistant-model.test.js`、`test/hermes-assistant-routes.test.js`、`test/assistant-i18n.test.js` | 新增／修改 | |

---

### Task 1: 假 Hermes 的 cron REST

**Files:** Modify `test-support/fake-hermes-gateway.cjs`

- [ ] **Step 1: 狀態與工具函式**

在 `state` 加入 `cron: []`；在 `sessionRow` 定義之後加入：

```js
  function cronJob(profile, body = {}) {
    const schedule = String(body.schedule || "");
    const kind = /^every /i.test(schedule) ? "interval" : /^\d{4}-\d{2}-\d{2}/.test(schedule) ? "once" : "cron";
    const minutes = kind === "interval" ? Number(/(\d+)/.exec(schedule)?.[1] || 0) * (/h$/i.test(schedule) ? 60 : 1) : undefined;
    return { id: `job${++state.next}`, profile, is_default_profile: profile === "default", name: String(body.name || ""), prompt: String(body.prompt || ""),
      schedule: { kind, ...(kind === "cron" ? { expr: schedule } : {}), ...(kind === "interval" ? { minutes } : {}), ...(kind === "once" ? { run_at: schedule } : {}), display: schedule },
      schedule_display: schedule, deliver: String(body.deliver || "local"), enabled: body.paused !== true, state: body.paused ? "paused" : "scheduled",
      next_run_at: body.paused ? null : "2026-10-16T07:00:00+08:00", last_run_at: null, last_status: null, last_error: null, last_delivery_error: null,
      model: body.model || null, provider: body.provider || null, skills: Array.isArray(body.skills) ? body.skills : [], no_agent: body.no_agent === true,
      script: body.script || null, repeat: { times: null, completed: 0 } };
  }
  const findJob = id => state.cron.find(job => job.id === id);
```

- [ ] **Step 2: 路由**

在 `/api/sessions/search` 處理之後、`const match = /^\/api\/sessions\/…/` 之前加入：

```js
      if (url.pathname === "/api/cron/delivery-targets" && req.method === "GET") {
        return send(200, { targets: [{ id: "local", name: "Local (save only)", home_target_set: true, home_env_var: null },
          { id: "telegram", name: "Telegram", home_target_set: true, home_env_var: "TELEGRAM_HOME_CHANNEL" }] }, rotated);
      }
      if (url.pathname === "/api/cron/jobs" && req.method === "GET") {
        const profile = url.searchParams.get("profile") || "all";
        return send(200, state.cron.filter(job => profile === "all" || job.profile === profile), rotated);
      }
      if (url.pathname === "/api/cron/jobs" && req.method === "POST") {
        const body = await readJson(req);
        if (!String(body.schedule || "").trim()) return send(400, { detail: "schedule required" });
        const job = cronJob(url.searchParams.get("profile") || "default", body);
        state.cron.push(job);
        broadcast("cron.changed", {});
        return send(200, job, rotated);
      }
      const cronMatch = /^\/api\/cron\/jobs\/([^/]+)(?:\/(pause|resume|trigger|runs))?$/.exec(url.pathname);
      if (cronMatch) {
        const job = findJob(decodeURIComponent(cronMatch[1]));
        if (!job) return send(404, { detail: "Job not found" });
        const verb = cronMatch[2];
        if (!verb && req.method === "GET") return send(200, job, rotated);
        if (!verb && req.method === "PUT") {
          const { updates = {} } = await readJson(req);
          for (const key of ["name", "prompt", "deliver", "model", "provider", "skills"]) if (updates[key] !== undefined) job[key] = updates[key];
          if (updates.schedule !== undefined) Object.assign(job, { schedule: cronJob(job.profile, { schedule: updates.schedule }).schedule, schedule_display: updates.schedule });
          broadcast("cron.changed", {});
          return send(200, job, rotated);
        }
        if (!verb && req.method === "DELETE") {
          state.cron = state.cron.filter(other => other !== job);
          broadcast("cron.changed", {});
          return send(200, { ok: true }, rotated);
        }
        if (verb === "pause" || verb === "resume") {
          Object.assign(job, { enabled: verb === "resume", state: verb === "resume" ? "scheduled" : "paused" });
          broadcast("cron.changed", {});
          return send(200, job, rotated);
        }
        if (verb === "trigger") {
          const row = { id: `cron_${job.id}_20261015_070000`, profile: job.profile, title: job.name, hidden: false, source: "cron",
            messages: [{ role: "assistant", text: `Ran ${job.name}` }], startedAt: 1_760_500_000, lastActive: 1_760_500_000, unread: true, running: false, inflight: null };
          state.stored.set(row.id, row);
          Object.assign(job, { last_run_at: "2026-10-15T07:00:00+08:00", last_status: "ok" });
          broadcast("cron.changed", {});
          return send(200, job, rotated);
        }
        if (verb === "runs") {
          const runs = [...state.stored.values()].filter(row => row.id.startsWith(`cron_${job.id}_`))
            .map(row => ({ id: row.id, title: row.title, preview: preview(row), source: "cron", started_at: row.startedAt }));
          runs.push({ id: `cron_output:${job.id}:latest`, title: "Script output", preview: null, source: "cron_output", started_at: 1_760_400_000 });
          return send(200, { runs, limit: 20 }, rotated);
        }
      }
```

並在 `api` 物件加入：`addRoutine(profile, body) { const job = cronJob(profile, body); state.cron.push(job); return job; },`

- [ ] **Step 3: 語法檢查並提交**

```bash
node --check test-support/fake-hermes-gateway.cjs
git add test-support/fake-hermes-gateway.cjs
git commit -m "Give the fake Hermes a cron API"
```

---

### Task 2: 排程與送達的純函式

**Files:** Modify `public/modules/assistant-model.js`；Test `test/assistant-model.test.js`

- [ ] **Step 1: 寫失敗的測試**（附加到 `test/assistant-model.test.js`）

```js
test("the schedule picker writes Hermes schedules and reads them back", () => {
  assert.equal(M.scheduleFromPicker({ kind: "daily", time: "07:05" }), "5 7 * * *");
  assert.equal(M.scheduleFromPicker({ kind: "weekdays", time: "09:00" }), "0 9 * * 1-5");
  assert.equal(M.scheduleFromPicker({ kind: "weekly", time: "18:30", weekday: "0" }), "30 18 * * 0");
  assert.equal(M.scheduleFromPicker({ kind: "interval", every: "2", unit: "h" }), "every 2h");
  assert.equal(M.scheduleFromPicker({ kind: "interval", every: "0", unit: "m" }), "every 1m");
  assert.equal(M.scheduleFromPicker({ kind: "once", at: "2026-10-16T09:00" }), "2026-10-16T09:00");
  assert.equal(M.scheduleFromPicker({ kind: "advanced", raw: "  0 */3 * * * " }), "0 */3 * * *");
  assert.deepEqual(M.pickerFromSchedule({ kind: "cron", expr: "15 3 * * *" }), { kind: "daily", time: "03:15" });
  assert.deepEqual(M.pickerFromSchedule({ kind: "cron", expr: "0 9 * * 1-5" }), { kind: "weekdays", time: "09:00" });
  assert.deepEqual(M.pickerFromSchedule({ kind: "cron", expr: "30 18 * * 0" }), { kind: "weekly", time: "18:30", weekday: 0 });
  assert.deepEqual(M.pickerFromSchedule({ kind: "interval", minutes: 120 }), { kind: "interval", every: 2, unit: "h" });
  assert.deepEqual(M.pickerFromSchedule({ kind: "interval", minutes: 45 }), { kind: "interval", every: 45, unit: "m" });
  assert.deepEqual(M.pickerFromSchedule({ kind: "once", runAt: "2026-10-16T09:00:00+08:00" }), { kind: "once", at: "2026-10-16T09:00" });
  assert.deepEqual(M.pickerFromSchedule({ kind: "cron", expr: "0 */3 * * *", display: "0 */3 * * *" }), { kind: "advanced", raw: "0 */3 * * *" });
});

test("delivery targets toggle without disturbing the others", () => {
  assert.deepEqual(M.deliverTokens(" telegram:1, bot-chat ,telegram:1"), ["telegram:1", "bot-chat"]);
  assert.equal(M.withDeliver("telegram:586668748", "bot-chat", true), "telegram:586668748,bot-chat");
  assert.equal(M.withDeliver("telegram:586668748,bot-chat", "bot-chat", false), "telegram:586668748");
  assert.equal(M.withDeliver("local", "bot-chat", true), "bot-chat");
  assert.equal(M.withDeliver("bot-chat", "bot-chat", false), "local");
  assert.equal(M.routineName("[bot:qa-reviewer] Nightly check"), "Nightly check");
  assert.equal(M.routineName("Setel Email Auto-Processor"), "Setel Email Auto-Processor");
});
```

- [ ] **Step 2: 確認失敗**

Run: `node --test test/assistant-model.test.js`
Expected: FAIL，`M.scheduleFromPicker is not a function`

- [ ] **Step 3: 實作**（在 `assistant-model.js` 的 `colorFor` 之後、`return` 之前加入，並把新函式加進 `return`）

```js
  const DAILY = /^(\d{1,2}) (\d{1,2}) \* \* \*$/, WEEKDAYS = /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/, WEEKLY = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/;
  const pad = value => String(value).padStart(2, "0");

  function scheduleFromPicker(picker = {}) {
    const time = /^(\d{1,2}):(\d{2})$/.exec(String(picker.time || ""));
    const hour = time ? Math.min(23, Number(time[1])) : 9, minute = time ? Math.min(59, Number(time[2])) : 0;
    switch (picker.kind) {
      case "daily": return `${minute} ${hour} * * *`;
      case "weekdays": return `${minute} ${hour} * * 1-5`;
      case "weekly": return `${minute} ${hour} * * ${Math.min(6, Math.max(0, Math.round(Number(picker.weekday) || 0)))}`;
      case "interval": return `every ${Math.max(1, Math.min(10_000, Math.round(Number(picker.every) || 1)))}${picker.unit === "h" ? "h" : "m"}`;
      case "once": return String(picker.at || "").trim();
      default: return String(picker.raw || "").trim();
    }
  }

  function pickerFromSchedule(schedule) {
    const value = schedule && typeof schedule === "object" ? schedule : { display: String(schedule || "") };
    const expr = String(value.expr || "").trim();
    const time = (minute, hour) => `${pad(hour)}:${pad(minute)}`;
    let match;
    if ((match = DAILY.exec(expr))) return { kind: "daily", time: time(match[1], match[2]) };
    if ((match = WEEKDAYS.exec(expr))) return { kind: "weekdays", time: time(match[1], match[2]) };
    if ((match = WEEKLY.exec(expr))) return { kind: "weekly", time: time(match[1], match[2]), weekday: Number(match[3]) };
    const minutes = Number(value.minutes);
    if (value.kind === "interval" && minutes > 0) return minutes % 60 === 0 ? { kind: "interval", every: minutes / 60, unit: "h" } : { kind: "interval", every: minutes, unit: "m" };
    if (value.kind === "once" && value.runAt) return { kind: "once", at: String(value.runAt).slice(0, 16) };
    return { kind: "advanced", raw: expr || String(value.display || "") };
  }

  function deliverTokens(value) {
    return [...new Set(String(value || "").split(",").map(token => token.trim()).filter(Boolean))];
  }
  function withDeliver(value, token, on) {
    const tokens = deliverTokens(value).filter(item => item !== token);
    if (on) tokens.push(token);
    const kept = tokens.length > 1 ? tokens.filter(item => item !== "local") : tokens;
    return kept.length ? kept.join(",") : "local";
  }
  const routineName = name => String(name || "").replace(/^\[bot:[^\]]{1,64}\]\s*/, "");
```

`return` 改為：`return { chooseHermesMachine, fromHistory, withInflight, applyEvent, userItem, systemItem, formatWhen, sourceLabel, initials, colorFor, scheduleFromPicker, pickerFromSchedule, deliverTokens, withDeliver, routineName };`

- [ ] **Step 4: 確認通過並提交**

```bash
node --test test/assistant-model.test.js
git add public/modules/assistant-model.js test/assistant-model.test.js
git commit -m "Write and read Hermes schedules for the routine editor"
```

---

### Task 3: 伺服器端例行工作模組

**Files:** Create `server/hermes-routines.js`；Test `test/hermes-routines.test.js`

- [ ] **Step 1: 寫失敗的測試**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHermesDiscovery } = require("../server/hermes-discovery");
const { createHermesSessionStore } = require("../server/hermes-session-store");
const { createHermesGatewayClient } = require("../server/hermes-gateway-client");
const { createHermesRoutines } = require("../server/hermes-routines");
const { createFakeHermesGateway } = require("../test-support/fake-hermes-gateway.cjs");

async function setup(t) {
  const fake = createFakeHermesGateway();
  await fake.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-hermes-routines-"));
  const client = createHermesGatewayClient({
    discovery: createHermesDiscovery({ env: { STEPSEMBLE_HERMES_URL: fake.url }, interfaces: () => ({}) }),
    store: createHermesSessionStore({ file: path.join(dir, "hermes-session.json") }),
  });
  await client.login("jerome", "correct horse");
  t.after(async () => { client.close(); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { fake, routines: createHermesRoutines({ client }) };
}

test("a Bot's routines are its profile's cron jobs, described plainly", async t => {
  const { fake, routines } = await setup(t);
  fake.addRoutine("default", { name: "Luna 每日情報簡報", schedule: "0 7 * * *", deliver: "telegram:586668748", prompt: "Brief me" });
  fake.addRoutine("qa-reviewer", { name: "[bot:qa-reviewer] Nightly check", schedule: "every 2h" });
  const luna = (await routines.list("default")).routines;
  assert.deepEqual(luna.map(job => [job.name, job.schedule.kind, job.schedule.display, job.deliver, job.enabled, job.profile]),
    [["Luna 每日情報簡報", "cron", "0 7 * * *", "telegram:586668748", true, "default"]]);
  assert.equal(luna[0].nextRunAt, "2026-10-16T07:00:00+08:00");
  const all = (await routines.list(null)).routines;
  assert.deepEqual(all.map(job => job.profile).sort(), ["default", "qa-reviewer"]);
  await assert.rejects(routines.list("../x"), error => error.statusCode === 400);
});

test("new routines are named like Bot Mode and land in the Bot Chat unless told otherwise", async t => {
  const { fake, routines } = await setup(t);
  const { routine } = await routines.create("qa-reviewer", { name: "Morning check", schedule: "0 9 * * 1-5", prompt: "Check subtitles" });
  assert.equal(routine.name, "[bot:qa-reviewer] Morning check");
  assert.equal(routine.deliver, "bot-chat");
  assert.equal(routine.profile, "qa-reviewer");
  assert.equal(fake.state.cron.at(-1).profile, "qa-reviewer");
  await assert.rejects(routines.create("qa-reviewer", { name: "x", schedule: " " }), error => error.code === "invalid_schedule");
  await assert.rejects(routines.create("qa-reviewer", { name: "x", schedule: "0 9 * * *", deliver: "telegram;rm -rf" }), error => error.code === "invalid_deliver");
});

test("editing keeps each routine's own naming and changes only what was sent", async t => {
  const { fake, routines } = await setup(t);
  const plain = fake.addRoutine("default", { name: "Setel Email Auto-Processor", schedule: "15 3 * * *", deliver: "telegram:586668748", prompt: "Process" });
  const bot = fake.addRoutine("qa-reviewer", { name: "[bot:qa-reviewer] Old", schedule: "every 30m" });
  assert.equal((await routines.update(plain.id, "default", { deliver: "telegram:586668748,bot-chat" })).routine.deliver, "telegram:586668748,bot-chat");
  assert.equal(fake.state.cron.find(job => job.id === plain.id).prompt, "Process", "untouched fields stay");
  assert.equal((await routines.update(plain.id, "default", { name: "Setel email" })).routine.name, "Setel email", "no prefix is added to an existing plain name");
  assert.equal((await routines.update(bot.id, "qa-reviewer", { name: "New" })).routine.name, "[bot:qa-reviewer] New");
  await assert.rejects(routines.update(plain.id, "default", {}), error => error.code === "nothing_to_update");
});

test("pause, resume, run now, history and delete go through Hermes", async t => {
  const { fake, routines } = await setup(t);
  const job = fake.addRoutine("default", { name: "Telco Bills", schedule: "0 10 * * *" });
  assert.equal((await routines.pause(job.id, "default")).routine.enabled, false);
  assert.equal((await routines.resume(job.id, "default")).routine.enabled, true);
  assert.equal((await routines.run(job.id, "default")).routine.lastStatus, "ok");
  const { runs } = await routines.runs(job.id, "default");
  assert.deepEqual(runs.map(run => [run.openable, run.title]), [[true, "Telco Bills"], [false, "Script output"]]);
  assert.deepEqual((await routines.targets("default")).targets.map(target => target.id), ["local", "telegram"]);
  await routines.remove(job.id, "default");
  assert.equal(fake.state.cron.length, 0);
  await assert.rejects(routines.pause("bad id!", "default"), error => error.code === "invalid_routine");
});
```

- [ ] **Step 2: 確認失敗**

Run: `node --test test/hermes-routines.test.js`
Expected: FAIL，`Cannot find module '../server/hermes-routines'`

- [ ] **Step 3: 實作**

```js
"use strict";

// Each Bot's routines are Hermes cron jobs in that Bot's profile. This module
// only reads and changes them through Hermes' own cron API; Hermes keeps and
// runs them. A routine made here is named the way Bot Mode names its own.

const { HermesError } = require("./hermes-gateway-client");

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const JOB = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN = /^(?:local|origin|all|bot-chat(?::[A-Za-z0-9][A-Za-z0-9._-]{0,63})?|[a-z][a-z0-9_]{1,31}(?::[A-Za-z0-9@#._:+-]{1,200})?)$/;
const SKILL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PREFIX = /^\[bot:[^\]]{1,64}\]\s*/;
const invalid = code => new HermesError(code, code, 400);
const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

function profileName(value) {
  const name = String(value || "");
  if (!PROFILE.test(name)) throw invalid("invalid_profile");
  return name;
}
function jobId(value) {
  const id = String(value || "");
  if (!JOB.test(id)) throw invalid("invalid_routine");
  return id;
}
function deliverValue(value) {
  const tokens = [...new Set(String(value || "").split(",").map(token => token.trim()).filter(Boolean))];
  if (tokens.length > 10 || tokens.some(token => !TOKEN.test(token))) throw invalid("invalid_deliver");
  return tokens.length ? tokens.join(",") : "local";
}
function scheduleValue(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 200 || /[\r\n]/.test(text)) throw invalid("invalid_schedule");
  return text;
}
function routine(job, profile) {
  if (!job || typeof job !== "object" || typeof job.id !== "string") return null;
  const value = job.schedule && typeof job.schedule === "object" ? job.schedule : {};
  return {
    id: job.id, profile: profile || clip(job.profile, 64) || "default", name: clip(job.name, 300), prompt: clip(job.prompt, 20000),
    schedule: { kind: clip(value.kind, 16), expr: clip(value.expr, 200), minutes: Number.isFinite(Number(value.minutes)) ? Number(value.minutes) : null,
      runAt: clip(value.run_at, 64), display: clip(job.schedule_display || value.display, 200) },
    enabled: job.enabled !== false, state: clip(job.state, 32), nextRunAt: clip(job.next_run_at, 64), lastRunAt: clip(job.last_run_at, 64),
    lastStatus: clip(job.last_status, 32), lastError: clip(job.last_error, 500), lastDeliveryError: clip(job.last_delivery_error, 500),
    deliver: clip(job.deliver, 500) || "local", model: clip(job.model, 200), provider: clip(job.provider, 100),
    skills: Array.isArray(job.skills) ? job.skills.filter(item => typeof item === "string").slice(0, 20) : [],
    noAgent: job.no_agent === true, hasScript: !!job.script,
  };
}
function fieldsFor(input, { profile, original }) {
  const out = {};
  if (input.name !== undefined) {
    const name = String(input.name || "").replace(/[\r\n]+/g, " ").trim().replace(PREFIX, "").slice(0, 200);
    out.name = name && (original === undefined || PREFIX.test(original)) ? `[bot:${profile}] ${name}` : name;
  }
  if (input.schedule !== undefined) out.schedule = scheduleValue(input.schedule);
  if (input.prompt !== undefined) {
    const prompt = String(input.prompt || "");
    if (prompt.length > 20000) throw invalid("invalid_prompt");
    out.prompt = prompt;
  }
  if (input.deliver !== undefined) out.deliver = deliverValue(input.deliver);
  if (input.model !== undefined) out.model = String(input.model || "").trim().slice(0, 200) || null;
  if (input.skills !== undefined) {
    if (!Array.isArray(input.skills) || input.skills.length > 20) throw invalid("invalid_skills");
    out.skills = input.skills.map(item => String(item).trim()).filter(item => SKILL.test(item));
  }
  return out;
}

function createHermesRoutines({ client }) {
  const jobPath = id => `/api/cron/jobs/${encodeURIComponent(jobId(id))}`;

  async function list(profile) {
    const scope = profile ? profileName(profile) : "all";
    const result = await client.rest("GET", "/api/cron/jobs", { query: { profile: scope } });
    const rows = Array.isArray(result) ? result : Array.isArray(result?.jobs) ? result.jobs : [];
    return { routines: rows.map(job => routine(job, profile ? scope : null)).filter(Boolean) };
  }
  async function targets(profile) {
    const result = await client.rest("GET", "/api/cron/delivery-targets", { query: { profile: profileName(profile) } });
    return { targets: (Array.isArray(result?.targets) ? result.targets : []).filter(target => target && typeof target.id === "string" && TOKEN.test(target.id))
      .map(target => ({ id: target.id, name: clip(target.name, 100) || target.id, ready: target.home_target_set !== false })) };
  }
  async function runs(id, profile) {
    const result = await client.rest("GET", `${jobPath(id)}/runs`, { query: { profile: profileName(profile), limit: 20 } });
    return { runs: (Array.isArray(result?.runs) ? result.runs : []).filter(run => run && typeof run.id === "string").map(run => ({
      id: clip(run.id, 200), title: clip(run.title, 300), preview: clip(run.preview, 300), startedAt: Number(run.started_at) || 0,
      openable: !run.id.startsWith("cron_output:") && run.source !== "cron_output" })) };
  }
  async function create(profile, input = {}) {
    const name = profileName(profile);
    const fields = fieldsFor({ deliver: "bot-chat", ...input }, { profile: name, original: undefined });
    if (!fields.schedule) throw invalid("invalid_schedule");
    const job = await client.rest("POST", "/api/cron/jobs", { query: { profile: name }, body: { ...fields, paused: false } });
    return { routine: routine(job, name) };
  }
  async function update(id, profile, input = {}) {
    const name = profileName(profile);
    const current = await client.rest("GET", jobPath(id), { query: { profile: name } });
    const fields = fieldsFor(input, { profile: name, original: typeof current?.name === "string" ? current.name : "" });
    if (!Object.keys(fields).length) throw invalid("nothing_to_update");
    const job = await client.rest("PUT", jobPath(id), { query: { profile: name }, body: { updates: fields } });
    return { routine: routine(job, name) };
  }
  const action = verb => async (id, profile) => {
    const name = profileName(profile);
    return { routine: routine(await client.rest("POST", `${jobPath(id)}/${verb}`, { query: { profile: name } }), name) };
  };
  async function remove(id, profile) {
    await client.rest("DELETE", jobPath(id), { query: { profile: profileName(profile) } });
    return { ok: true };
  }

  return Object.freeze({ list, targets, runs, create, update, pause: action("pause"), resume: action("resume"), run: action("trigger"), remove });
}

module.exports = { createHermesRoutines };
```

- [ ] **Step 4: 確認通過並提交**

```bash
node --test test/hermes-routines.test.js
git add server/hermes-routines.js test/hermes-routines.test.js
git commit -m "Read and change each Bot's routines through Hermes cron"
```

---

### Task 4: 路由與接線

**Files:** Modify `server/hermes-assistant-routes.js`、`server.js`；Test `test/hermes-assistant-routes.test.js`

- [ ] **Step 1: 寫失敗的測試**（附加到 `test/hermes-assistant-routes.test.js`；`serve` 改成接受 `routines`）

把 `serve` 的簽名改為 `async function serve(t, service, routines = null)`，`createHermesAssistantRoutes({ service, routines, readJSON, sendJSON, sseFrame, trySseWrite })`。再附加：

```js
test("routine routes pass the Bot and the routine through, GET and POST only", async t => {
  const calls = [];
  const record = name => async (...args) => { calls.push([name, ...args]); return { ok: true }; };
  const routines = { list: record("list"), targets: record("targets"), runs: record("runs"), create: record("create"), update: record("update"),
    pause: record("pause"), resume: record("resume"), run: record("run"), remove: record("remove") };
  const base = await serve(t, {}, routines);
  await fetch(base + "/api/assistant/routines?profile=default");
  await fetch(base + "/api/assistant/routines");
  await fetch(base + "/api/assistant/routines/targets?profile=default");
  await fetch(base + "/api/assistant/routines/runs?id=job1&profile=default");
  await post(base, "/api/assistant/routines/create", { profile: "default", fields: { schedule: "0 9 * * *" } });
  await post(base, "/api/assistant/routines/update", { id: "job1", profile: "default", fields: { deliver: "bot-chat" } });
  for (const verb of ["pause", "resume", "run", "delete"]) await post(base, `/api/assistant/routines/${verb}`, { id: "job1", profile: "default" });
  assert.deepEqual(calls, [["list", "default"], ["list", null], ["targets", "default"], ["runs", "job1", "default"],
    ["create", "default", { schedule: "0 9 * * *" }], ["update", "job1", "default", { deliver: "bot-chat" }],
    ["pause", "job1", "default"], ["resume", "job1", "default"], ["run", "job1", "default"], ["remove", "job1", "default"]]);
});
```

- [ ] **Step 2: 確認失敗**

Run: `node --test test/hermes-assistant-routes.test.js`
Expected: FAIL（新 test 的 calls 為空，回 404）

- [ ] **Step 3: 實作路由**

`createHermesAssistantRoutes({ service, routines, readJSON, sendJSON, sseFrame, trySseWrite })`，在 `/api/assistant/watch` 分支之前加入：

```js
      else if (p === "/api/assistant/routines" && get) sendJSON(res, 200, await routines.list(url.searchParams.get("profile") || null));
      else if (p === "/api/assistant/routines/targets" && get) sendJSON(res, 200, await routines.targets(url.searchParams.get("profile")));
      else if (p === "/api/assistant/routines/runs" && get) sendJSON(res, 200, await routines.runs(url.searchParams.get("id"), url.searchParams.get("profile")));
      else if (p === "/api/assistant/routines/create" && post) {
        const body = await readJSON(req, SMALL);
        sendJSON(res, 200, await routines.create(body.profile, body.fields || {}));
      } else if (p === "/api/assistant/routines/update" && post) {
        const body = await readJSON(req, SMALL);
        sendJSON(res, 200, await routines.update(body.id, body.profile, body.fields || {}));
      } else if (/^\/api\/assistant\/routines\/(pause|resume|run|delete)$/.test(p) && post) {
        const body = await readJSON(req, SMALL);
        const verb = p.slice("/api/assistant/routines/".length);
        sendJSON(res, 200, await routines[verb === "delete" ? "remove" : verb](body.id, body.profile));
      }
```

- [ ] **Step 4: server.js 接線**

require 區加入 `const { createHermesRoutines } = require("./server/hermes-routines");`。把建立 `hermesAssistant` 的程式改成先建立 client 變數：

```js
const hermesClient = createHermesGatewayClient({
  discovery: createHermesDiscovery(),
  store: createHermesSessionStore({ file: path.join(CONFIG_DIR, "hermes-session.json") }),
  log: (...args) => console.warn(...args),
});
const hermesAssistant = createHermesAssistantService({
  client: hermesClient,
  installed: () => !!hermesCommand,
  notify: notice => { void deliverPushNotification({ url: notice.url }, notice.title, notice.body); },
});
const handleHermesAssistantRoute = createHermesAssistantRoutes({ service: hermesAssistant, routines: createHermesRoutines({ client: hermesClient }),
  readJSON, sendJSON, sseFrame, trySseWrite });
```

- [ ] **Step 5: 確認通過並提交**

```bash
node --test test/hermes-assistant-routes.test.js test/hermes-assistant-http.test.js && node --check server.js
git add server/hermes-assistant-routes.js server.js test/hermes-assistant-routes.test.js
git commit -m "Serve each Bot's routines"
```

---

### Task 5: 例行工作字串（11 種語言）

**Files:** Modify `public/modules/assistant-i18n.js`；Test `test/assistant-i18n.test.js` 不需改（新鍵自動受「每個語言都有」檢查）

- [ ] **Step 1: 加入第二組鍵與翻譯**

在 `const rows = {…};` 之後加入 `ROUTINE_KEYS` 與 `routineRows`，並把建表迴圈改成同時合併兩組：

```js
  const ROUTINE_KEYS = ["routines", "allRoutines", "noRoutines", "newRoutine", "editRoutine", "routineName", "when", "daily", "weekdays", "weekly",
    "interval", "oneTime", "advanced", "atTime", "onDay", "minutes", "hours", "rawSchedule", "instructions", "deliverTo", "botChatTarget",
    "alsoBotChat", "modelOptional", "skillsOptional", "nextRun", "statusOk", "statusFailed", "statusDeliveryFailed", "paused", "pause", "resume",
    "runNow", "confirmRun", "history", "noRuns", "scriptOnly"];
  const routineRows = {
    "en": ["Routines", "All routines", "No routines yet.", "New routine", "Edit routine", "Name", "When", "Every day", "Weekdays", "Every week",
      "Repeat every", "Once", "Advanced", "At", "On", "Minutes", "Hours", "Hermes schedule", "What to do", "Send the result to", "This Bot's chat",
      "Also send to this Bot's chat", "Model (optional)", "Skills (optional, comma separated)", "Next {time}", "Succeeded", "Failed", "Could not deliver",
      "Paused", "Pause", "Resume", "Run now", "Tap again to run now", "History", "No runs yet.", "Runs a script without the AI"],
    "zh-Hant": ["例行工作", "所有例行工作", "還沒有例行工作。", "新增例行工作", "編輯例行工作", "名稱", "執行時間", "每天", "平日", "每週", "每隔", "一次", "進階",
      "時間", "星期", "分鐘", "小時", "Hermes 排程", "要做什麼", "結果送到", "這個 Bot 的對話", "同時送到這個 Bot 的對話", "模型（選填）", "技能（選填，以逗號分隔）",
      "下次 {time}", "成功", "失敗", "無法送達", "已暫停", "暫停", "繼續", "立即執行", "再點一次立即執行", "執行紀錄", "還沒有執行紀錄。", "只執行腳本，不使用 AI"],
    "zh-Hans": ["例行任务", "所有例行任务", "还没有例行任务。", "新建例行任务", "编辑例行任务", "名称", "执行时间", "每天", "工作日", "每周", "每隔", "一次", "高级",
      "时间", "星期", "分钟", "小时", "Hermes 日程", "要做什么", "结果发送到", "这个 Bot 的对话", "同时发送到这个 Bot 的对话", "模型（选填）", "技能（选填，用逗号分隔）",
      "下次 {time}", "成功", "失败", "无法送达", "已暂停", "暂停", "继续", "立即运行", "再点一次立即运行", "运行记录", "还没有运行记录。", "只运行脚本，不使用 AI"],
    "ja": ["ルーティン", "すべてのルーティン", "ルーティンはまだありません。", "新しいルーティン", "ルーティンを編集", "名前", "実行タイミング", "毎日", "平日", "毎週",
      "繰り返し間隔", "1 回だけ", "詳細", "時刻", "曜日", "分", "時間", "Hermes のスケジュール", "やること", "結果の送信先", "この Bot のチャット",
      "この Bot のチャットにも送る", "モデル（任意）", "スキル（任意、カンマ区切り）", "次回 {time}", "成功", "失敗", "配信できませんでした", "一時停止中", "一時停止",
      "再開", "今すぐ実行", "もう一度タップすると今すぐ実行", "履歴", "まだ実行されていません。", "AI を使わずスクリプトだけを実行"],
    "ko": ["루틴", "모든 루틴", "아직 루틴이 없습니다.", "새 루틴", "루틴 편집", "이름", "실행 시점", "매일", "평일", "매주", "반복 간격", "한 번", "고급", "시각",
      "요일", "분", "시간", "Hermes 일정", "할 일", "결과 보낼 곳", "이 Bot의 채팅", "이 Bot의 채팅에도 보내기", "모델(선택)", "스킬(선택, 쉼표로 구분)", "다음 {time}",
      "성공", "실패", "전달하지 못함", "일시 중지됨", "일시 중지", "재개", "지금 실행", "한 번 더 누르면 지금 실행", "기록", "아직 실행 기록이 없습니다.",
      "AI 없이 스크립트만 실행"],
    "tr": ["Rutinler", "Tüm rutinler", "Henüz rutin yok.", "Yeni rutin", "Rutini düzenle", "Ad", "Ne zaman", "Her gün", "Hafta içi", "Her hafta",
      "Şu aralıkla tekrarla", "Bir kez", "Gelişmiş", "Saat", "Gün", "Dakika", "Saat", "Hermes zamanlaması", "Ne yapılacak", "Sonucu gönder", "Bu Bot'un sohbeti",
      "Bu Bot'un sohbetine de gönder", "Model (isteğe bağlı)", "Beceriler (isteğe bağlı, virgülle ayırın)", "Sonraki {time}", "Başarılı", "Başarısız",
      "Teslim edilemedi", "Duraklatıldı", "Duraklat", "Devam ettir", "Şimdi çalıştır", "Şimdi çalıştırmak için tekrar dokunun", "Geçmiş", "Henüz çalıştırma yok.",
      "Yapay zekâ olmadan yalnızca betik çalıştırır"],
    "fr": ["Routines", "Toutes les routines", "Aucune routine pour l’instant.", "Nouvelle routine", "Modifier la routine", "Nom", "Quand", "Chaque jour",
      "En semaine", "Chaque semaine", "Répéter toutes les", "Une fois", "Avancé", "À", "Le", "Minutes", "Heures", "Planification Hermes", "À faire",
      "Envoyer le résultat à", "La discussion de ce Bot", "Envoyer aussi dans la discussion de ce Bot", "Modèle (facultatif)",
      "Compétences (facultatif, séparées par des virgules)", "Prochaine : {time}", "Réussi", "Échec", "Envoi impossible", "En pause", "Mettre en pause",
      "Reprendre", "Exécuter maintenant", "Touchez encore pour exécuter", "Historique", "Aucune exécution pour l’instant.", "Exécute un script sans l’IA"],
    "de": ["Routinen", "Alle Routinen", "Noch keine Routinen.", "Neue Routine", "Routine bearbeiten", "Name", "Wann", "Jeden Tag", "Werktags", "Jede Woche",
      "Wiederholen alle", "Einmal", "Erweitert", "Um", "Am", "Minuten", "Stunden", "Hermes-Zeitplan", "Was zu tun ist", "Ergebnis senden an",
      "Chat dieses Bots", "Auch an den Chat dieses Bots senden", "Modell (optional)", "Skills (optional, durch Kommas getrennt)", "Nächste: {time}",
      "Erfolgreich", "Fehlgeschlagen", "Konnte nicht zugestellt werden", "Pausiert", "Pausieren", "Fortsetzen", "Jetzt ausführen", "Zum Ausführen erneut tippen",
      "Verlauf", "Noch keine Ausführungen.", "Führt ein Skript ohne KI aus"],
    "es": ["Rutinas", "Todas las rutinas", "Todavía no hay rutinas.", "Nueva rutina", "Editar rutina", "Nombre", "Cuándo", "Cada día", "Días laborables",
      "Cada semana", "Repetir cada", "Una vez", "Avanzado", "A las", "El", "Minutos", "Horas", "Programación de Hermes", "Qué hacer", "Enviar el resultado a",
      "El chat de este Bot", "Enviar también al chat de este Bot", "Modelo (opcional)", "Habilidades (opcional, separadas por comas)", "Próxima: {time}",
      "Correcto", "Falló", "No se pudo entregar", "En pausa", "Pausar", "Reanudar", "Ejecutar ahora", "Toca otra vez para ejecutar", "Historial",
      "Todavía no hay ejecuciones.", "Ejecuta un script sin la IA"],
    "pt-BR": ["Rotinas", "Todas as rotinas", "Ainda não há rotinas.", "Nova rotina", "Editar rotina", "Nome", "Quando", "Todo dia", "Dias úteis", "Toda semana",
      "Repetir a cada", "Uma vez", "Avançado", "Às", "Em", "Minutos", "Horas", "Agenda do Hermes", "O que fazer", "Enviar o resultado para",
      "A conversa deste Bot", "Enviar também para a conversa deste Bot", "Modelo (opcional)", "Habilidades (opcional, separadas por vírgula)", "Próxima: {time}",
      "Concluída", "Falhou", "Não foi possível entregar", "Pausada", "Pausar", "Retomar", "Executar agora", "Toque de novo para executar", "Histórico",
      "Ainda não há execuções.", "Executa um script sem a IA"],
    "it": ["Routine", "Tutte le routine", "Ancora nessuna routine.", "Nuova routine", "Modifica routine", "Nome", "Quando", "Ogni giorno", "Giorni feriali",
      "Ogni settimana", "Ripeti ogni", "Una volta", "Avanzate", "Alle", "Il", "Minuti", "Ore", "Pianificazione Hermes", "Cosa fare", "Invia il risultato a",
      "La chat di questo Bot", "Invia anche alla chat di questo Bot", "Modello (facoltativo)", "Skill (facoltative, separate da virgole)", "Prossima: {time}",
      "Riuscita", "Non riuscita", "Impossibile consegnare", "In pausa", "Metti in pausa", "Riprendi", "Esegui ora", "Tocca di nuovo per eseguire", "Cronologia",
      "Ancora nessuna esecuzione.", "Esegue uno script senza l’IA"],
  };
```

建表迴圈改為：

```js
  const tables = {};
  for (const [keys, set] of [[KEYS, rows], [ROUTINE_KEYS, routineRows]]) {
    for (const [locale, values] of Object.entries(set)) {
      if (values.length !== keys.length) throw new Error(`assistant-i18n: ${locale} has ${values.length} strings, expected ${keys.length}`);
      tables[locale] = { ...(tables[locale] || {}), ...Object.fromEntries(keys.map((key, index) => [key, values[index]])) };
    }
  }
  for (const locale of Object.keys(tables)) Object.freeze(tables[locale]);
```

- [ ] **Step 2: 確認並提交**

```bash
node --test test/assistant-i18n.test.js
git add public/modules/assistant-i18n.js
git commit -m "Name routines in every Stepsemble language"
```

---

### Task 6: 例行工作畫面

**Files:** Create `public/modules/assistant-routines.js`；Modify `public/modules/assistant-api.js`、`public/modules/assistant.js`、`public/modules/assistant.css`、`public/assistant.html`、`package.json`

- [ ] **Step 1: API**（`assistant-api.js` 的 `create()` 回傳物件加入）

```js
      routines: profile => call(`/api/assistant/routines${profile ? `?${new URLSearchParams({ profile })}` : ""}`),
      routineTargets: profile => call(`/api/assistant/routines/targets?${new URLSearchParams({ profile })}`),
      routineRuns: (id, profile) => call(`/api/assistant/routines/runs?${new URLSearchParams({ id, profile })}`),
      createRoutine: (profile, fields) => post("/api/assistant/routines/create", { profile, fields }),
      updateRoutine: (id, profile, fields) => post("/api/assistant/routines/update", { id, profile, fields }),
      pauseRoutine: (id, profile) => post("/api/assistant/routines/pause", { id, profile }),
      resumeRoutine: (id, profile) => post("/api/assistant/routines/resume", { id, profile }),
      runRoutine: (id, profile) => post("/api/assistant/routines/run", { id, profile }),
      deleteRoutine: (id, profile) => post("/api/assistant/routines/delete", { id, profile }),
```

- [ ] **Step 2: `public/modules/assistant-routines.js`**

```js
(function (root) {
  "use strict";

  // Each Bot's routines (Hermes cron jobs of its profile): list, edit, run.
  // Hermes keeps and runs them; this view only reads and changes them
  // through /api/assistant/routines on the computer that runs Hermes.

  function create({ api, t, el, button, toast, M, locale, botName, openSession }) {
    const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
    // 2026-01-04 is a Sunday, so day 0 is Sunday like cron's.
    const dayName = day => new Date(Date.UTC(2026, 0, 4 + day)).toLocaleDateString(locale, { weekday: "long", timeZone: "UTC" });
    const when = iso => { const at = Date.parse(iso || ""); return Number.isFinite(at) ? M.formatWhen(at, Date.now(), locale) : ""; };
    function statusText(job) {
      if (job.lastDeliveryError) return t("statusDeliveryFailed");
      if (["ok", "success", "completed"].includes(job.lastStatus)) return t("statusOk");
      return job.lastStatus ? t("statusFailed") : "";
    }
    function twoTap(label, confirm, className, action) {
      let armed = false;
      const node = button(label, className, async () => {
        if (!armed) {
          armed = true;
          node.textContent = confirm;
          setTimeout(() => { armed = false; node.textContent = label; }, 4000);
          return;
        }
        node.disabled = true;
        try { await action(); } catch (error) { toast(t("failed", { message: error.message })); node.disabled = false; }
      });
      return node;
    }

    async function list(container, profile) {
      container.replaceChildren(el("p", "assistant-empty", t("loading")));
      try { render(container, (await api.routines(profile)).routines || [], profile); } catch (error) {
        container.replaceChildren(el("p", "assistant-error", t("failed", { message: error.message })));
      }
    }

    function render(container, jobs, profile) {
      const wrap = el("div", "assistant-routines");
      if (profile) wrap.append(button(t("newRoutine"), "btn primary assistant-new-routine", () => editor(container, profile, null, profile)));
      if (!jobs.length) wrap.append(el("p", "assistant-empty", t("noRoutines")));
      let group = null;
      for (const job of profile ? jobs : [...jobs].sort((a, b) => a.profile.localeCompare(b.profile))) {
        if (!profile && job.profile !== group) { group = job.profile; wrap.append(el("h2", "assistant-routine-group", botName(group))); }
        wrap.append(row(container, job, profile));
      }
      container.replaceChildren(wrap);
    }

    function row(container, job, profile) {
      const item = el("section", `assistant-routine${job.enabled ? "" : " paused"}`);
      item.dataset.routine = job.id;
      const head = el("div", "assistant-routine-head");
      head.append(el("strong", "", M.routineName(job.name) || job.prompt.slice(0, 60) || t("untitled")));
      if (!job.enabled) head.append(el("span", "assistant-routine-tag", t("paused")));
      const facts = [job.schedule.display, job.enabled && job.nextRunAt ? t("nextRun", { time: when(job.nextRunAt) }) : "", statusText(job),
        job.noAgent ? t("scriptOnly") : ""].filter(Boolean);
      const toggle = el("label", "assistant-check");
      const box = el("input");
      box.type = "checkbox";
      box.checked = M.deliverTokens(job.deliver).includes("bot-chat");
      toggle.append(box, el("span", "", t("alsoBotChat")));
      box.addEventListener("change", async () => {
        box.disabled = true;
        try { Object.assign(job, (await api.updateRoutine(job.id, job.profile, { deliver: M.withDeliver(job.deliver, "bot-chat", box.checked) })).routine); }
        catch (error) { box.checked = !box.checked; toast(t("failed", { message: error.message })); } finally { box.disabled = false; }
      });
      const refresh = updated => { Object.assign(job, updated.routine); item.replaceWith(row(container, job, profile)); };
      const actions = el("div", "assistant-routine-actions");
      actions.append(
        button(job.enabled ? t("pause") : t("resume"), "btn ghost", async () => {
          try { refresh(await (job.enabled ? api.pauseRoutine(job.id, job.profile) : api.resumeRoutine(job.id, job.profile))); }
          catch (error) { toast(t("failed", { message: error.message })); }
        }),
        twoTap(t("runNow"), t("confirmRun"), "btn ghost", async () => refresh(await api.runRoutine(job.id, job.profile))),
        button(t("history"), "btn ghost", () => void showRuns(item, job)),
        button(t("editRoutine"), "btn ghost", () => editor(container, job.profile, job, profile)),
        twoTap(t("delete"), t("confirmDelete"), "btn ghost assistant-danger", async () => { await api.deleteRoutine(job.id, job.profile); item.remove(); }),
      );
      item.append(head, el("small", "assistant-routine-facts", facts.join(" · ")), toggle, actions);
      return item;
    }

    async function showRuns(item, job) {
      const open = item.querySelector(".assistant-runs");
      if (open) { open.remove(); return; }
      const box = el("ul", "assistant-runs");
      box.append(el("li", "assistant-empty", t("loading")));
      item.append(box);
      try {
        const runs = (await api.routineRuns(job.id, job.profile)).runs || [];
        box.replaceChildren();
        if (!runs.length) box.append(el("li", "assistant-empty", t("noRuns")));
        for (const run of runs) {
          const entry = el("li");
          const label = [run.title || t("untitled"), M.formatWhen(run.startedAt, Date.now(), locale)].filter(Boolean).join(" · ");
          entry.append(run.openable ? button(label, "assistant-run-open", () => openSession(job.profile, run.id, run.title)) : el("span", "", label));
          if (run.preview) entry.append(el("small", "", run.preview));
          box.append(entry);
        }
      } catch (error) { box.replaceChildren(el("li", "assistant-error", t("failed", { message: error.message }))); }
    }

    function labeled(label, ...nodes) {
      const wrap = el("label", "assistant-field");
      wrap.append(el("span", "", label), ...nodes);
      return wrap;
    }
    function select(options, value) {
      const node = el("select");
      for (const [key, label] of options) { const option = el("option", "", label); option.value = key; node.append(option); }
      node.value = value;
      return node;
    }

    function editor(container, profile, job, listProfile) {
      const picker = job ? M.pickerFromSchedule(job.schedule) : { kind: "daily", time: "09:00" };
      const form = el("form", "assistant-routine-form");
      const name = el("input");
      name.value = job ? M.routineName(job.name) : "";
      const kind = select([["daily", t("daily")], ["weekdays", t("weekdays")], ["weekly", t("weekly")], ["interval", t("interval")],
        ["once", t("oneTime")], ["advanced", t("advanced")]], picker.kind);
      const time = el("input"); time.type = "time"; time.value = picker.time || "09:00";
      const weekday = select(WEEKDAYS.map(day => [String(day), dayName(day)]), String(picker.weekday ?? 1));
      const every = el("input"); every.type = "number"; every.min = "1"; every.value = String(picker.every || 30);
      const unit = select([["m", t("minutes")], ["h", t("hours")]], picker.unit || "m");
      const at = el("input"); at.type = "datetime-local"; at.value = picker.at || "";
      const raw = el("input"); raw.value = picker.raw || ""; raw.placeholder = "0 9 * * 1-5";
      const parts = { time: labeled(t("atTime"), time), weekday: labeled(t("onDay"), weekday), every: labeled(t("interval"), every, unit),
        at: labeled(t("atTime"), at), raw: labeled(t("rawSchedule"), raw) };
      const showParts = () => {
        parts.time.hidden = !["daily", "weekdays", "weekly"].includes(kind.value);
        parts.weekday.hidden = kind.value !== "weekly";
        parts.every.hidden = kind.value !== "interval";
        parts.at.hidden = kind.value !== "once";
        parts.raw.hidden = kind.value !== "advanced";
      };
      kind.addEventListener("change", showParts);
      showParts();
      const schedule = el("fieldset", "assistant-routine-schedule");
      schedule.append(el("legend", "", t("when")), kind, ...Object.values(parts));
      const prompt = el("textarea");
      prompt.rows = 4;
      prompt.value = job?.prompt || "";
      const deliver = el("fieldset", "assistant-routine-deliver");
      deliver.append(el("legend", "", t("deliverTo")));
      const chosen = M.deliverTokens(job ? job.deliver : "bot-chat");
      const checks = [];
      const addTarget = (token, label) => {
        if (checks.some(box => box.value === token)) return;
        const wrap = el("label", "assistant-check");
        const box = el("input");
        box.type = "checkbox"; box.value = token; box.checked = chosen.includes(token);
        wrap.append(box, el("span", "", label));
        deliver.append(wrap);
        checks.push(box);
      };
      addTarget("bot-chat", t("botChatTarget"));
      const addChosen = () => { for (const token of chosen) addTarget(token, token); };
      void api.routineTargets(profile).then(data => { for (const target of data.targets || []) addTarget(target.id, target.name); addChosen(); }).catch(addChosen);
      const model = el("input"); model.value = job?.model || "";
      const skills = el("input"); skills.value = (job?.skills || []).join(", ");
      const error = el("p", "assistant-error"); error.hidden = true;
      const save = button(t("save"), "btn primary", null, "submit");
      const actions = el("div", "assistant-ask-actions");
      actions.append(save, button(t("cancel"), "btn ghost", () => void list(container, listProfile)));
      form.append(el("h2", "", job ? t("editRoutine") : t("newRoutine")), labeled(t("routineName"), name), schedule, labeled(t("instructions"), prompt),
        deliver, labeled(t("modelOptional"), model), labeled(t("skillsOptional"), skills), error, actions);
      form.addEventListener("submit", async event => {
        event.preventDefault();
        const tokens = checks.filter(box => box.checked).map(box => box.value);
        const fields = { name: name.value.trim(), prompt: prompt.value, deliver: tokens.length ? tokens.join(",") : "local", model: model.value.trim(),
          skills: skills.value.split(",").map(item => item.trim()).filter(Boolean),
          schedule: M.scheduleFromPicker({ kind: kind.value, time: time.value, weekday: weekday.value, every: every.value, unit: unit.value, at: at.value, raw: raw.value }) };
        save.disabled = true;
        error.hidden = true;
        try {
          if (job) await api.updateRoutine(job.id, profile, fields); else await api.createRoutine(profile, fields);
          await list(container, listProfile);
        } catch (failure) {
          error.textContent = t("failed", { message: failure.message });
          error.hidden = false;
          save.disabled = false;
        }
      });
      container.replaceChildren(form);
      name.focus();
    }

    return Object.freeze({ list });
  }

  root.StepsembleAssistantRoutines = Object.freeze({ create });
})(window);
```

- [ ] **Step 3: 接進助理頁**

`public/assistant.html`：在 `assistant-api.js` 之後加入 `<script src="/modules/assistant-routines.js?v=3.8.62"></script>`。

`public/modules/assistant.js`：
1. 宣告區加入 `let routinesView = null;`，並在 `start()` 建立 `api` 之後加入：

```js
    routinesView = window.StepsembleAssistantRoutines.create({ api, t, el, button, toast, M, locale: prefs.locale,
      botName: profile => bots.find(bot => bot.name === profile)?.displayName || profile,
      openSession: (profile, sessionId, title) => void openBot(profile, sessionId, { title }) });
```

2. `showRoster()` 的 `head.append(el("h1", "", t("bots")), pending);` 改為：

```js
    const all = button(t("allRoutines"), "btn ghost assistant-all-routines", () => {
      screen = "routines";
      const box = el("section", "assistant-roster");
      const top = el("div", "assistant-section-head");
      const back = button("‹", "btn ghost assistant-back", showRoster);
      back.setAttribute("aria-label", t("back"));
      top.append(back, el("h1", "", t("allRoutines")));
      const body = el("div");
      box.append(top, body);
      render(box);
      void routinesView.list(body, null);
    });
    head.append(el("h1", "", t("bots")), pending, all);
```

3. `botView()` 的分頁清單改為 `[["chat", t("chat")], ["other", t("otherChats")], ["routines", t("routines")]]`，並在 `if (tab === "other") { … }` 之後加入：

```js
    if (tab === "routines") {
      const body = el("div", "assistant-sessions");
      wrap.append(body);
      void routinesView.list(body, chat.profile);
      return wrap;
    }
```

4. `handleEvent` 不需修改：`cron.changed` 走既有的 `scheduleReload()`，它只在名單頁重畫；例行工作清單與表單由各自的操作即時更新，不會在編輯中被重畫。

- [ ] **Step 4: 樣式**（附加到 `assistant.css`）

```css
.assistant-all-routines { margin-left: auto; }
.assistant-routines { display: grid; gap: 10px; }
.assistant-new-routine { justify-self: start; }
.assistant-routine-group { margin: 12px 0 0; font-size: .95rem; color: var(--pine-soft); }
.assistant-routine { padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--milk); }
.assistant-routine.paused { opacity: .7; }
.assistant-routine-head { display: flex; align-items: center; gap: 8px; }
.assistant-routine-tag { padding: 0 8px; border-radius: 999px; background: var(--bubble-user); color: var(--pine-soft); font-size: .75rem; }
.assistant-routine-facts { display: block; margin: 4px 0 8px; color: var(--pine-soft); font-size: .8rem; }
.assistant-routine-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.assistant-check { display: flex; align-items: center; gap: 8px; font-size: .85rem; }
.assistant-runs { margin: 8px 0 0; padding: 0; list-style: none; }
.assistant-runs li { padding: 6px 0; border-top: 1px solid var(--line); }
.assistant-runs small { display: block; color: var(--pine-soft); }
.assistant-run-open { padding: 0; border: 0; background: transparent; color: var(--accent); font: inherit; text-align: left; cursor: pointer; }
.assistant-routine-form { display: grid; gap: 12px; }
.assistant-routine-form h2 { margin: 0; font-size: 1.05rem; }
.assistant-routine-form fieldset { display: grid; gap: 8px; margin: 0; padding: 10px; border: 1px solid var(--line); border-radius: 10px; }
.assistant-routine-form input, .assistant-routine-form textarea, .assistant-routine-form select { width: 100%; box-sizing: border-box; padding: 9px 10px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--paper); color: var(--ink); font: inherit; font-size: 16px; }
.assistant-routine-form .assistant-check input { width: auto; }
```

- [ ] **Step 5: 檢查腳本**：`check:assistant` 結尾加 `&& node --check public/modules/assistant-routines.js`

- [ ] **Step 6: 語法檢查並提交**

```bash
node --check public/modules/assistant-routines.js && node --check public/modules/assistant.js && node --check public/modules/assistant-api.js
git add public/modules/assistant-routines.js public/modules/assistant-api.js public/modules/assistant.js public/modules/assistant.css public/assistant.html package.json
git commit -m "Show and edit each Bot's routines on the assistant page"
```

---

### Task 7: 瀏覽器測試

**Files:** Modify `scripts/assistant-browser-cases.mjs`

- [ ] **Step 1: 在 `stage = "Workspace switch";` 之前加入**

```js
      stage = "routines";
      const brief = preview.fake.addRoutine("default", { name: "Luna 每日情報簡報", schedule: "0 7 * * *", deliver: "telegram:586668748", prompt: "Brief me" });
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.getByRole("tab", { name: "Routines", exact: true }).click();
      const routine = page.locator(".assistant-routine", { hasText: "Luna 每日情報簡報" });
      await routine.waitFor();
      assert.match(await routine.textContent(), /0 7 \* \* \*/);
      await routine.getByLabel("Also send to this Bot's chat").check();
      for (let tries = 0; tries < 50 && preview.fake.state.cron.find(job => job.id === brief.id).deliver !== "telegram:586668748,bot-chat"; tries += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(preview.fake.state.cron.find(job => job.id === brief.id).deliver, "telegram:586668748,bot-chat");
      await page.getByRole("button", { name: "New routine", exact: true }).click();
      await page.getByLabel("Name").fill("Weekly review");
      await page.getByLabel("What to do").fill("Summarise my week");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.locator(".assistant-routine", { hasText: "Weekly review" }).waitFor();
      const created = preview.fake.state.cron.at(-1);
      assert.deepEqual([created.name, created.schedule_display, created.deliver, created.profile], ["[bot:default] Weekly review", "0 9 * * *", "bot-chat", "default"]);
      await shot("routines");
```

（`Back` 從「其他對話」打開的對話回到 Luna 的 Bot Chat，再切到「例行工作」分頁。）

- [ ] **Step 2: 執行**

Run: `node scripts/assistant-browser-cases.mjs <Playwright runtime>`
Expected: `assistant browser cases passed`

- [ ] **Step 3: Commit**

```bash
git add scripts/assistant-browser-cases.mjs
git commit -m "Test routines on the assistant page in a browser"
```

---

### Task 8: 文件與完整驗證

- [ ] **Step 1:** `docs/hermes-assistant.md` 的「使用」加一項：「每個 Bot 的『例行工作』分頁（以及名單頁的『所有例行工作』）列出 Hermes cron job：可暫停、立即執行、看執行紀錄、編輯、刪除；『同時送到這個 Bot 的對話』會在送達清單加入或移除 `bot-chat`。在這裡新增的例行工作依 Bot Mode 慣例命名為 `[bot:<profile>] <名稱>`。」架構段加 `server/hermes-routines.js`。
- [ ] **Step 2:** `npm run check && npm test && npm run version:check`，全部 0 fail。
- [ ] **Step 3:** Commit `Document routines on the assistant page`。
