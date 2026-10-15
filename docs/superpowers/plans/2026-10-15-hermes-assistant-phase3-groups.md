# Hermes 助理 第 3 階段（群組聊天）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 名單頁新增「群組」區：建立 2～6 個同一台機器 Bot 的群組、在群組裡傳訊息（`@名稱` 指名、`@all` 指名全體）、看每個 Bot 的回覆、停止、回應成員的核准請求、重試失敗的回合、改名、解散（兩段確認）。Hermes 不支援群組驅動時顯示「需要更新 Hermes」。

**Architecture:** 新模組 `server/hermes-groups.js` 只呼叫 Hermes 的 `groups.*` JSON-RPC（hosted room）；輪流發言與 `@` 解析都由 Hermes 後端負責。路由掛在 `/api/assistant/groups*`（GET／POST）。瀏覽器在群組開著且畫面可見時，每 1.5 秒以 `groups.log` 的序號游標補新事件、每 3 秒讀 `groups.state`（是否在處理、待核准、可重試）。前端新增 `public/modules/assistant-groups.js`。

**Hermes 0.21.6 事實（已讀原始碼確認）：**
- `groups.capabilities {}` → `{driver, features, methods, max_log_limit, …}`；`driver` 不是 `true` 表示這個 Hermes 不能自己帶群組。
- `groups.list {limit, offset}` → `{rooms, next_offset}`；room：`room_id, name, members[{member_id, profile, handle, display_name}], updated_at, disbanded_at, latest_seq`。
- `groups.create {room_id, name, members}`：`room_id` 由客戶端產生（冪等）；成員欄位只能是 `member_id, profile, handle`（必填）與 `display_name`、`target`；2～6 人；識別字元 `^[A-Za-z0-9][A-Za-z0-9._:-]*$`、最長 128；`handle` 不可為 `all`／`everyone` 且不可重複。
- `groups.send {room_id, event_id, payload: {text, thread_id}}`，`payload` 只能有這兩個欄位。
- `groups.log {room_id, since_seq, limit}` → `{events, cursor, latest_seq, has_more}`；event：`seq, event_id, kind, actor{kind,id}, payload, created_at`。種類包括 `message.user`、`message.member`（`payload.text`、`payload.member_id`）、`turn.started/settled/failed/deferred/cancelled`、`room.renamed`、`room.stop_requested`、`member.unavailable`、`room.disbanded`。
- `groups.state {room_id}` → `{room, driver_status{running, working, blocked, pending_actions}}`；核准動作：`{kind:"approval", member_id, task_id, execution_generation, request_id, approval{command, description, choices}}`；重試動作：`{kind:"retry", task_id}`。
- `groups.approve {room_id, member_id, task_id, execution_generation, choice, request_id}`；`groups.retry {room_id, task_id}`；`groups.stop {room_id}`；`groups.rename {room_id, event_id, name}`；`groups.disband {room_id}`。

---

## 檔案結構

| 檔案 | 動作 | 職責 |
|---|---|---|
| `test-support/fake-hermes-gateway.cjs` | 修改 | `groups.*` RPC 與簡單的成員回覆 |
| `server/hermes-groups.js` | 新增 | 群組的讀寫與驗證 |
| `server/hermes-assistant-routes.js`、`server.js` | 修改 | `/api/assistant/groups*` |
| `public/modules/assistant-i18n.js` | 修改 | 群組字串（11 種語言） |
| `public/modules/assistant-api.js` | 修改 | groups 呼叫 |
| `public/modules/assistant-groups.js` | 新增 | 群組畫面 |
| `public/modules/assistant.js`、`assistant.css`、`public/assistant.html`、`package.json` | 修改 | 名單頁群組區、樣式、載入、檢查 |
| 測試：`test/hermes-groups.test.js`、`test/hermes-assistant-routes.test.js`、`scripts/assistant-browser-cases.mjs` | 新增／修改 | |

---

### Task 1: 假 Hermes 的群組 RPC

**Files:** Modify `test-support/fake-hermes-gateway.cjs`

- [ ] **Step 1:** `state` 加入 `rooms: new Map(), roomEvents: new Map(), groupDriver: true, groupApproval: null, groupCalls: []`。

- [ ] **Step 2:** 在 `handleRpc` 的 `switch` 中、`default:` 之前加入：

```js
      case "groups.capabilities":
        return reply({ protocol_version: 1, driver: state.groupDriver, persistent_process: true, authority_gateway_id: installId,
          room_link: { enabled: false, reason: "disabled" }, features: ["discussion"], methods: ["groups.create", "groups.send"], max_log_limit: 500 });
      case "groups.list":
        return reply({ rooms: [...state.rooms.values()].filter(room => p.include_disbanded || !room.disbanded_at), next_offset: null });
      case "groups.create": {
        const members = Array.isArray(p.members) ? p.members : [];
        if (members.length < 2 || members.length > 6) return fail(4100, "members must contain between 2 and 6 entries");
        for (const member of members) {
          if (Object.keys(member).some(key => !["member_id", "profile", "handle", "display_name", "target"].includes(key))) return fail(4100, "unexpected member field");
          if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(member.handle || "") || ["all", "everyone"].includes(member.handle)) return fail(4100, "invalid handle");
        }
        const room = state.rooms.get(p.room_id) || { room_id: p.room_id, name: p.name, members, authority_gateway_id: installId, authority_epoch: 1,
          revision: 1, created_at: 1_760_000_000, updated_at: 1_760_000_000, disbanded_at: null, latest_seq: 0 };
        state.rooms.set(room.room_id, room);
        state.roomEvents.set(room.room_id, state.roomEvents.get(room.room_id) || []);
        return reply({ room });
      }
      case "groups.send": {
        const room = state.rooms.get(p.room_id);
        if (!room) return fail(4101, "room not found");
        const keys = Object.keys(p.payload || {}).sort().join(",");
        if (keys !== "text,thread_id") return fail(4100, "user payload must have exactly text and thread_id");
        state.groupCalls.push({ method: "send", text: p.payload.text, threadId: p.payload.thread_id });
        const event = appendRoomEvent(room, "message.user", { kind: "user", id: "owner" }, { text: p.payload.text, thread_id: p.payload.thread_id });
        reply({ event, accepted: true, driver_started: true });
        void answerRoom(room, p.payload.text);
        return undefined;
      }
      case "groups.log": {
        const events = (state.roomEvents.get(p.room_id) || []).filter(event => event.seq > (Number(p.since_seq) || 0)).slice(0, Number(p.limit) || 200);
        const room = state.rooms.get(p.room_id);
        return reply({ events, cursor: events.at(-1)?.seq ?? (Number(p.since_seq) || 0), latest_seq: room?.latest_seq || 0, has_more: false,
          authority: { gateway_id: installId, epoch: 1 } });
      }
      case "groups.state": {
        const room = state.rooms.get(p.room_id);
        if (!room) return fail(4101, "room not found");
        return reply({ room, driver_status: { running: true, working: !!state.groupApproval, blocked: !!state.groupApproval, counts: {},
          pending_actions: state.groupApproval ? [state.groupApproval] : [], peer_routes: [] } });
      }
      case "groups.stop":
        state.groupCalls.push({ method: "stop", room: p.room_id });
        appendRoomEvent(state.rooms.get(p.room_id), "room.stop_requested", { kind: "user", id: "owner" }, {});
        return reply({ cancelled: 1 });
      case "groups.approve":
        state.groupCalls.push({ method: "approve", ...p });
        state.groupApproval = null;
        return reply({ approved: true, result: { resolved: true } });
      case "groups.retry":
        state.groupCalls.push({ method: "retry", ...p });
        return reply({ retried: true, task: { room_id: p.room_id, task_id: p.task_id, thread_id: "main", turn_id: "t1", status: "queued", execution_generation: 2, cancel_generation: 0 } });
      case "groups.rename": {
        const room = state.rooms.get(p.room_id);
        room.name = p.name;
        appendRoomEvent(room, "room.renamed", { kind: "user", id: "owner" }, { name: p.name });
        return reply({ room });
      }
      case "groups.disband": {
        const room = state.rooms.get(p.room_id);
        room.disbanded_at = 1_760_600_000;
        return reply({ tombstone: { room_id: room.room_id, disbanded_at: room.disbanded_at, idempotent: false } });
      }
```

- [ ] **Step 3:** 在 `runTurn` 定義之後加入：

```js
  function appendRoomEvent(room, kind, actor, payload) {
    const events = state.roomEvents.get(room.room_id);
    room.latest_seq += 1;
    const event = { room_id: room.room_id, seq: room.latest_seq, event_id: `ev-${++state.next}`, kind, actor, payload, created_at: 1_760_000_000 + room.latest_seq };
    events.push(event);
    return event;
  }
  async function answerRoom(room, text) {
    const handles = [...String(text).matchAll(/@([A-Za-z0-9][A-Za-z0-9._:-]*)/g)].map(match => match[1].toLowerCase());
    const everyone = handles.includes("all") || handles.includes("everyone") || !handles.length;
    for (const member of room.members) {
      if (!everyone && !handles.includes(member.handle.toLowerCase())) continue;
      await new Promise(resolve => setTimeout(resolve, 20));
      appendRoomEvent(room, "turn.started", { kind: "member", id: member.member_id }, { member_id: member.member_id });
      appendRoomEvent(room, "message.member", { kind: "member", id: member.member_id }, { text: `${member.display_name || member.handle} heard: ${text}`, member_id: member.member_id });
      appendRoomEvent(room, "turn.settled", { kind: "member", id: member.member_id }, { member_id: member.member_id });
    }
  }
```

`api` 物件加入 `requestGroupApproval(roomId, memberId) { state.groupApproval = { kind: "approval", member_id: memberId, task_id: "task-1", execution_generation: 1, run_id: "run-1", session_id: "live-x", request_id: "appr-g1", approval: { request_id: "appr-g1", command: "rm -rf cache", description: "Clear the cache", choices: ["once", "deny"] } }; },`。

- [ ] **Step 4:** `node --check test-support/fake-hermes-gateway.cjs`；Commit `Give the fake Hermes hosted group rooms`。

---

### Task 2: 伺服器端群組模組

**Files:** Create `server/hermes-groups.js`；Test `test/hermes-groups.test.js`

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
const { createHermesGroups, handleFor } = require("../server/hermes-groups");
const { createFakeHermesGateway } = require("../test-support/fake-hermes-gateway.cjs");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function setup(t) {
  const fake = createFakeHermesGateway();
  await fake.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-hermes-groups-"));
  const client = createHermesGatewayClient({
    discovery: createHermesDiscovery({ env: { STEPSEMBLE_HERMES_URL: fake.url }, interfaces: () => ({}) }),
    store: createHermesSessionStore({ file: path.join(dir, "hermes-session.json") }),
  });
  await client.login("jerome", "correct horse");
  t.after(async () => { client.close(); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { fake, groups: createHermesGroups({ client }) };
}

test("handles are readable, unique and never the reserved @all", () => {
  const used = new Set();
  assert.equal(handleFor({ profile: "default", displayName: "Luna" }, used), "luna");
  assert.equal(handleFor({ profile: "qa-reviewer", displayName: "QA Reviewer" }, used), "qa-reviewer");
  assert.equal(handleFor({ profile: "x", displayName: "Luna" }, used), "luna-2");
  assert.equal(handleFor({ profile: "all", displayName: "All" }, used), "all-bot");
  assert.equal(handleFor({ profile: "image-artist", displayName: "影像" }, used), "image-artist");
});

test("a group of local Bots is created, talks, and reads back in order", async t => {
  const { fake, groups } = await setup(t);
  assert.deepEqual(await groups.capabilities(), { supported: true, driver: true });
  const { room } = await groups.create({ name: "Production", members: [{ profile: "default", displayName: "Luna" }, { profile: "qa-reviewer", displayName: "QA Reviewer" }] });
  assert.equal(room.name, "Production");
  assert.deepEqual(room.members.map(member => [member.profile, member.handle, member.displayName]), [["default", "luna", "Luna"], ["qa-reviewer", "qa-reviewer", "QA Reviewer"]]);
  assert.match(room.id, /^stepsemble-[0-9a-f-]{36}$/);
  await groups.send(room.id, "@luna what is next?");
  assert.deepEqual(fake.state.groupCalls.at(-1), { method: "send", text: "@luna what is next?", threadId: "main" });
  await sleep(150);
  const log = await groups.log(room.id, 0);
  assert.deepEqual(log.events.map(event => [event.kind, event.memberId || null]),
    [["message.user", null], ["turn.started", "default"], ["message.member", "default"], ["turn.settled", "default"]]);
  assert.equal(log.events[2].text, "Luna heard: @luna what is next?");
  assert.equal((await groups.log(room.id, log.cursor)).events.length, 0, "the cursor skips what was read");
  assert.deepEqual((await groups.list()).rooms.map(row => row.name), ["Production"]);
  await assert.rejects(groups.create({ name: "Solo", members: [{ profile: "default", displayName: "Luna" }] }), error => error.code === "invalid_members");
  await assert.rejects(groups.send(room.id, "  "), error => error.code === "empty_message");
});

test("a member's approval, a stop, a retry, a rename and disbanding go to Hermes", async t => {
  const { fake, groups } = await setup(t);
  const { room } = await groups.create({ name: "Ops", members: [{ profile: "default", displayName: "Luna" }, { profile: "qa-reviewer", displayName: "QA" }] });
  fake.requestGroupApproval(room.id, "default");
  const state = await groups.state(room.id);
  assert.equal(state.working, true);
  assert.deepEqual(state.approvals.map(item => [item.memberId, item.command, item.choices]), [["default", "rm -rf cache", ["once", "deny"]]]);
  await groups.approve(room.id, { ...state.approvals[0], choice: "once" });
  assert.deepEqual(fake.state.groupCalls.at(-1), { method: "approve", room_id: room.id, member_id: "default", task_id: "task-1", execution_generation: 1, choice: "once", request_id: "appr-g1" });
  await assert.rejects(groups.approve(room.id, { ...state.approvals[0], choice: "always" }), error => error.code === "invalid_choice");
  await groups.stop(room.id);
  await groups.retry(room.id, "task-1");
  assert.equal((await groups.rename(room.id, "Ops room")).room.name, "Ops room");
  await groups.disband(room.id);
  assert.deepEqual((await groups.list()).rooms, []);
  assert.deepEqual(fake.state.groupCalls.map(call => call.method), ["approve", "stop", "retry"]);
});

test("a Hermes without the group driver says so instead of failing later", async t => {
  const { fake, groups } = await setup(t);
  fake.state.groupDriver = false;
  assert.deepEqual(await groups.capabilities(), { supported: false, driver: false });
});
```

- [ ] **Step 2: 確認失敗**：`node --test test/hermes-groups.test.js` → `Cannot find module '../server/hermes-groups'`

- [ ] **Step 3: 實作**

```js
"use strict";

// Group chats are Hermes hosted rooms: Hermes schedules who speaks and reads
// @mentions; this module only creates rooms of local Bots, sends the user's
// messages, and reads the room log and state back. Nothing is stored here.

const { randomUUID } = require("node:crypto");
const { HermesError } = require("./hermes-gateway-client");

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROOM = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const THREAD = "main";
const invalid = code => new HermesError(code, code, 400);
const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

function roomId(value) {
  const id = String(value || "");
  if (!ROOM.test(id)) throw invalid("invalid_room");
  return id;
}

// A mention handle from the Bot's name: lower case, letters, digits and dashes,
// unique in the room, and never the reserved @all or @everyone.
function handleFor({ profile, displayName }, used) {
  const slug = value => String(value || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "").slice(0, 40);
  let base = slug(displayName) || slug(profile) || "bot";
  if (base === "all" || base === "everyone") base = `${base}-bot`;
  let handle = base, index = 2;
  while (used.has(handle)) handle = `${base}-${index++}`;
  used.add(handle);
  return handle;
}

function room(row) {
  if (!row || typeof row.room_id !== "string") return null;
  return {
    id: row.room_id, name: clip(row.name, 200),
    members: (Array.isArray(row.members) ? row.members : []).map(member => ({ memberId: clip(member?.member_id, 128), profile: clip(member?.profile, 64),
      handle: clip(member?.handle, 64), displayName: clip(member?.display_name, 120) || clip(member?.handle, 64) })),
    updatedAt: Number(row.updated_at) || 0, latestSeq: Number(row.latest_seq) || 0, disbanded: row.disbanded_at !== null && row.disbanded_at !== undefined,
  };
}

function event(row) {
  const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
  return { seq: Number(row?.seq) || 0, kind: clip(row?.kind, 64), actor: { kind: clip(row?.actor?.kind, 32), id: clip(row?.actor?.id, 128) },
    text: clip(payload.text, 256 * 1024), memberId: clip(payload.member_id, 128) || (row?.actor?.kind === "member" ? clip(row.actor.id, 128) : ""),
    name: clip(payload.name, 200), createdAt: Number(row?.created_at) || 0 };
}

function createHermesGroups({ client }) {
  async function capabilities() {
    try {
      const result = await client.request("groups.capabilities", {}, { timeoutMs: 15_000 });
      return { supported: result?.driver === true, driver: result?.driver === true };
    } catch (error) {
      if (/method not found|unknown method|no handler/i.test(String(error?.message))) return { supported: false, driver: false };
      throw error;
    }
  }
  async function list() {
    const result = await client.request("groups.list", { limit: 100 }, { timeoutMs: 30_000 });
    return { rooms: (Array.isArray(result?.rooms) ? result.rooms : []).map(room).filter(row => row && !row.disbanded) };
  }
  async function create({ name, members } = {}) {
    const title = String(name || "").replace(/[\r\n]+/g, " ").trim().slice(0, 120);
    if (!title) throw invalid("invalid_name");
    if (!Array.isArray(members) || members.length < 2 || members.length > 6) throw invalid("invalid_members");
    const used = new Set(), seen = new Set();
    const roster = members.map(member => {
      const profile = String(member?.profile || "");
      if (!PROFILE.test(profile) || seen.has(profile)) throw invalid("invalid_members");
      seen.add(profile);
      const displayName = String(member?.displayName || profile).trim().slice(0, 80);
      return { member_id: profile, profile, handle: handleFor({ profile, displayName }, used), display_name: displayName };
    });
    const result = await client.request("groups.create", { room_id: `stepsemble-${randomUUID()}`, name: title, members: roster }, { timeoutMs: 30_000 });
    return { room: room(result?.room) };
  }
  async function send(id, text) {
    const body = typeof text === "string" ? text : "";
    if (!body.trim()) throw invalid("empty_message");
    if (body.length > 64 * 1024) throw invalid("text_too_long");
    await client.request("groups.send", { room_id: roomId(id), event_id: `stepsemble-${randomUUID()}`, payload: { text: body, thread_id: THREAD } }, { timeoutMs: 30_000 });
    return { ok: true };
  }
  async function log(id, since = 0) {
    const from = Number.isSafeInteger(Number(since)) && Number(since) >= 0 ? Number(since) : 0;
    const result = await client.request("groups.log", { room_id: roomId(id), since_seq: from, limit: 200 }, { timeoutMs: 30_000 });
    const events = (Array.isArray(result?.events) ? result.events : []).map(event);
    return { events, cursor: Number(result?.cursor) || events.at(-1)?.seq || from, latestSeq: Number(result?.latest_seq) || 0, hasMore: result?.has_more === true };
  }
  async function state(id) {
    const result = await client.request("groups.state", { room_id: roomId(id) }, { timeoutMs: 30_000 });
    const status = result?.driver_status && typeof result.driver_status === "object" ? result.driver_status : {};
    const actions = Array.isArray(status.pending_actions) ? status.pending_actions : [];
    return {
      room: room(result?.room), working: status.working === true, blocked: status.blocked === true,
      approvals: actions.filter(action => action?.kind === "approval").map(action => ({ memberId: clip(action.member_id, 128), taskId: clip(action.task_id, 128),
        executionGeneration: Number(action.execution_generation) || 0, requestId: clip(action.request_id, 128),
        command: clip(action.approval?.command, 4000), description: clip(action.approval?.description, 2000),
        choices: (Array.isArray(action.approval?.choices) ? action.approval.choices : ["once", "deny"]).filter(choice => ["once", "deny"].includes(choice)) })),
      retries: actions.filter(action => action?.kind === "retry").map(action => ({ taskId: clip(action.task_id, 128) })),
    };
  }
  async function approve(id, { memberId, taskId, executionGeneration, requestId, choice } = {}) {
    if (!["once", "deny"].includes(choice)) throw invalid("invalid_choice");
    for (const value of [memberId, taskId, requestId]) if (!ID.test(String(value || ""))) throw invalid("invalid_request");
    if (!Number.isSafeInteger(executionGeneration) || executionGeneration < 0) throw invalid("invalid_request");
    await client.request("groups.approve", { room_id: roomId(id), member_id: memberId, task_id: taskId, execution_generation: executionGeneration,
      choice, request_id: requestId }, { timeoutMs: 30_000 });
    return { ok: true };
  }
  async function retry(id, taskId) {
    if (!ID.test(String(taskId || ""))) throw invalid("invalid_request");
    await client.request("groups.retry", { room_id: roomId(id), task_id: taskId }, { timeoutMs: 30_000 });
    return { ok: true };
  }
  async function rename(id, name) {
    const title = String(name || "").replace(/[\r\n]+/g, " ").trim().slice(0, 120);
    if (!title) throw invalid("invalid_name");
    const result = await client.request("groups.rename", { room_id: roomId(id), event_id: `stepsemble-${randomUUID()}`, name: title }, { timeoutMs: 30_000 });
    return { room: room(result?.room) };
  }
  const simple = method => async id => { await client.request(method, { room_id: roomId(id) }, { timeoutMs: 30_000 }); return { ok: true }; };

  return Object.freeze({ capabilities, list, create, send, log, state, approve, retry, rename, stop: simple("groups.stop"), disband: simple("groups.disband") });
}

module.exports = { createHermesGroups, handleFor };
```

- [ ] **Step 4:** `node --test test/hermes-groups.test.js` → 4 pass；Commit `Talk to Hermes group rooms`。

---

### Task 3: 路由與接線

**Files:** Modify `server/hermes-assistant-routes.js`、`server.js`；Test `test/hermes-assistant-routes.test.js`

- [ ] **Step 1: 寫失敗的測試**（`serve` 加第四個參數 `groups = null` 並傳入 `createHermesAssistantRoutes`）

```js
test("group routes pass the room through, GET and POST only", async t => {
  const calls = [];
  const record = name => async (...args) => { calls.push([name, ...args]); return { ok: true }; };
  const groups = { capabilities: async () => ({ supported: true, driver: true }), list: async () => ({ rooms: [] }), create: record("create"),
    send: record("send"), log: record("log"), state: record("state"), approve: record("approve"), retry: record("retry"),
    rename: record("rename"), stop: record("stop"), disband: record("disband") };
  const base = await serve(t, {}, null, groups);
  assert.deepEqual(await (await fetch(base + "/api/assistant/groups")).json(), { supported: true, driver: true, rooms: [] });
  await post(base, "/api/assistant/groups/create", { name: "Ops", members: [{ profile: "a" }, { profile: "b" }] });
  await fetch(base + "/api/assistant/groups/log?room=r1&since=4");
  await fetch(base + "/api/assistant/groups/state?room=r1");
  await post(base, "/api/assistant/groups/send", { room: "r1", text: "@all hi" });
  await post(base, "/api/assistant/groups/approve", { room: "r1", memberId: "a", taskId: "t", executionGeneration: 1, requestId: "q", choice: "once" });
  await post(base, "/api/assistant/groups/retry", { room: "r1", taskId: "t" });
  await post(base, "/api/assistant/groups/rename", { room: "r1", name: "New" });
  await post(base, "/api/assistant/groups/stop", { room: "r1" });
  await post(base, "/api/assistant/groups/disband", { room: "r1" });
  assert.deepEqual(calls, [["create", { name: "Ops", members: [{ profile: "a" }, { profile: "b" }] }], ["log", "r1", "4"], ["state", "r1"],
    ["send", "r1", "@all hi"], ["approve", "r1", { memberId: "a", taskId: "t", executionGeneration: 1, requestId: "q", choice: "once" }],
    ["retry", "r1", "t"], ["rename", "r1", "New"], ["stop", "r1"], ["disband", "r1"]]);
});
```

- [ ] **Step 2: 確認失敗**，**Step 3: 實作**（路由簽名加 `groups`，在 routines 分支之後加入）：

```js
      else if (p === "/api/assistant/groups" && get) {
        const capabilities = await groups.capabilities();
        sendJSON(res, 200, { ...capabilities, rooms: capabilities.supported ? (await groups.list()).rooms : [] });
      } else if (p === "/api/assistant/groups/create" && post) sendJSON(res, 200, await groups.create(await readJSON(req, SMALL)));
      else if (p === "/api/assistant/groups/log" && get) sendJSON(res, 200, await groups.log(url.searchParams.get("room"), url.searchParams.get("since") || "0"));
      else if (p === "/api/assistant/groups/state" && get) sendJSON(res, 200, await groups.state(url.searchParams.get("room")));
      else if (/^\/api\/assistant\/groups\/(send|approve|retry|rename|stop|disband)$/.test(p) && post) {
        const body = await readJSON(req, SMALL);
        const verb = p.slice("/api/assistant/groups/".length);
        const extra = { send: body.text, approve: { memberId: body.memberId, taskId: body.taskId, executionGeneration: body.executionGeneration,
          requestId: body.requestId, choice: body.choice }, retry: body.taskId, rename: body.name }[verb];
        sendJSON(res, 200, extra === undefined ? await groups[verb](body.room) : await groups[verb](body.room, extra));
      }
```

`server.js`：require `createHermesGroups`，路由建立時加 `groups: createHermesGroups({ client: hermesClient })`。

- [ ] **Step 4:** 測試通過；Commit `Serve group chats`。

---

### Task 4: 群組字串（11 種語言）

`assistant-i18n.js` 加第三組 `GROUP_KEYS`／`groupRows`，建表迴圈的清單加 `[GROUP_KEYS, groupRows]`：

```js
  const GROUP_KEYS = ["groups", "newGroup", "groupName", "pickMembers", "createGroup", "noGroups", "groupsUnsupported", "mentionHint",
    "messageGroup", "disband", "confirmDisband", "memberUnavailable", "turnFailed", "renamedTo", "stopRequested", "retryTurn"];
  const groupRows = {
    "en": ["Groups", "New group", "Group name", "Choose 2 to 6 Bots", "Create group", "No groups yet.", "Group chats need a newer Hermes.",
      "Use @name to ask one Bot, or @all for everyone.", "Message the group", "Disband", "Tap again to disband", "{name} is unavailable",
      "{name} could not answer", "Renamed to {name}", "Stopped", "Try again"],
    "zh-Hant": ["群組", "新增群組", "群組名稱", "選 2 到 6 個 Bot", "建立群組", "還沒有群組。", "群組聊天需要較新版本的 Hermes。",
      "用 @名稱 指名一個 Bot，或用 @all 叫所有人。", "傳訊息給群組", "解散", "再點一次就解散", "{name} 目前無法使用", "{name} 無法回答",
      "已改名為 {name}", "已停止", "再試一次"],
    "zh-Hans": ["群组", "新建群组", "群组名称", "选 2 到 6 个 Bot", "创建群组", "还没有群组。", "群组聊天需要较新版本的 Hermes。",
      "用 @名称 指定一个 Bot，或用 @all 叫所有人。", "给群组发消息", "解散", "再点一次即解散", "{name} 目前无法使用", "{name} 无法回答",
      "已改名为 {name}", "已停止", "再试一次"],
    "ja": ["グループ", "新しいグループ", "グループ名", "Bot を 2〜6 個選ぶ", "グループを作成", "グループはまだありません。", "グループチャットには新しい Hermes が必要です。",
      "@名前 で 1 つの Bot を指名、@all で全員に聞けます。", "グループにメッセージ", "解散", "もう一度タップすると解散", "{name} は利用できません",
      "{name} は回答できませんでした", "{name} に名前を変更しました", "停止しました", "もう一度試す"],
    "ko": ["그룹", "새 그룹", "그룹 이름", "Bot을 2~6개 선택", "그룹 만들기", "아직 그룹이 없습니다.", "그룹 채팅에는 더 새로운 Hermes가 필요합니다.",
      "@이름으로 한 Bot에게, @all로 모두에게 물어보세요.", "그룹에 메시지", "해산", "한 번 더 누르면 해산", "{name}을(를) 사용할 수 없습니다",
      "{name}이(가) 답하지 못했습니다", "{name}(으)로 이름을 바꿨습니다", "중지됨", "다시 시도"],
    "tr": ["Gruplar", "Yeni grup", "Grup adı", "2 ile 6 arasında Bot seçin", "Grubu oluştur", "Henüz grup yok.", "Grup sohbetleri daha yeni bir Hermes gerektirir.",
      "Bir Bot'a sormak için @ad, herkese sormak için @all kullanın.", "Gruba mesaj", "Dağıt", "Dağıtmak için tekrar dokunun", "{name} kullanılamıyor",
      "{name} yanıt veremedi", "Adı {name} olarak değiştirildi", "Durduruldu", "Tekrar dene"],
    "fr": ["Groupes", "Nouveau groupe", "Nom du groupe", "Choisissez de 2 à 6 Bots", "Créer le groupe", "Aucun groupe pour l’instant.",
      "Les discussions de groupe nécessitent un Hermes plus récent.", "Utilisez @nom pour interroger un Bot, ou @all pour tout le monde.", "Message au groupe",
      "Dissoudre", "Touchez encore pour dissoudre", "{name} est indisponible", "{name} n’a pas pu répondre", "Renommé en {name}", "Arrêté", "Réessayer"],
    "de": ["Gruppen", "Neue Gruppe", "Gruppenname", "Wähle 2 bis 6 Bots", "Gruppe erstellen", "Noch keine Gruppen.", "Gruppenchats brauchen ein neueres Hermes.",
      "Mit @Name fragst du einen Bot, mit @all alle.", "Nachricht an die Gruppe", "Auflösen", "Zum Auflösen erneut tippen", "{name} ist nicht verfügbar",
      "{name} konnte nicht antworten", "Umbenannt in {name}", "Gestoppt", "Erneut versuchen"],
    "es": ["Grupos", "Nuevo grupo", "Nombre del grupo", "Elige de 2 a 6 Bots", "Crear grupo", "Todavía no hay grupos.", "Los chats de grupo necesitan un Hermes más reciente.",
      "Usa @nombre para preguntar a un Bot, o @all para todos.", "Mensaje al grupo", "Disolver", "Toca otra vez para disolver", "{name} no está disponible",
      "{name} no pudo responder", "Renombrado como {name}", "Detenido", "Reintentar"],
    "pt-BR": ["Grupos", "Novo grupo", "Nome do grupo", "Escolha de 2 a 6 Bots", "Criar grupo", "Ainda não há grupos.", "Conversas em grupo precisam de um Hermes mais novo.",
      "Use @nome para perguntar a um Bot, ou @all para todos.", "Mensagem para o grupo", "Desfazer", "Toque de novo para desfazer", "{name} está indisponível",
      "{name} não conseguiu responder", "Renomeado para {name}", "Parado", "Tentar de novo"],
    "it": ["Gruppi", "Nuovo gruppo", "Nome del gruppo", "Scegli da 2 a 6 Bot", "Crea gruppo", "Ancora nessun gruppo.", "Le chat di gruppo richiedono un Hermes più recente.",
      "Usa @nome per chiedere a un Bot, o @all per tutti.", "Messaggio al gruppo", "Sciogli", "Tocca di nuovo per sciogliere", "{name} non è disponibile",
      "{name} non ha potuto rispondere", "Rinominato in {name}", "Fermato", "Riprova"],
  };
```

Commit `Name group chats in every Stepsemble language`。

---

### Task 5: 群組畫面

**Files:** Create `public/modules/assistant-groups.js`；Modify `assistant-api.js`、`assistant.js`、`assistant.css`、`assistant.html`、`package.json`

- [ ] **Step 1: API**（`create()` 回傳物件加入）

```js
      groups: () => call("/api/assistant/groups"),
      createGroup: (name, members) => post("/api/assistant/groups/create", { name, members }),
      groupLog: (room, since) => call(`/api/assistant/groups/log?${new URLSearchParams({ room, since: String(since) })}`),
      groupState: room => call(`/api/assistant/groups/state?${new URLSearchParams({ room })}`),
      groupSend: (room, text) => post("/api/assistant/groups/send", { room, text }),
      groupApprove: (room, approval, choice) => post("/api/assistant/groups/approve", { room, ...approval, choice }),
      groupRetry: (room, taskId) => post("/api/assistant/groups/retry", { room, taskId }),
      groupRename: (room, name) => post("/api/assistant/groups/rename", { room, name }),
      groupStop: room => post("/api/assistant/groups/stop", { room }),
      groupDisband: room => post("/api/assistant/groups/disband", { room }),
```

- [ ] **Step 2: `public/modules/assistant-groups.js`**

```js
(function (root) {
  "use strict";

  // Group chats: Hermes hosted rooms of local Bots. Hermes decides who speaks
  // and reads @mentions; this view shows the room log, sends messages, and
  // answers the approvals a member raises. While a room is open and visible
  // it reads new events every 1.5 s and the room state every 3 s.

  function create({ api, t, el, button, toast, M, avatar, markdown, bots, onBack }) {
    let open = null;

    function section(container, data, onOpen) {
      const wrap = el("section", "assistant-groups");
      const head = el("div", "assistant-section-head");
      head.append(el("h2", "", t("groups")));
      if (data.supported) head.append(button(t("newGroup"), "btn ghost", () => picker(container, onOpen)));
      wrap.append(head);
      if (!data.supported) { wrap.append(el("p", "assistant-empty", t("groupsUnsupported"))); return wrap; }
      if (!data.rooms.length) wrap.append(el("p", "assistant-empty", t("noGroups")));
      const list = el("ul", "assistant-bot-list");
      for (const room of data.rooms) {
        const row = button("", "assistant-bot-row assistant-group-row", () => onOpen(room));
        const faces = el("span", "assistant-group-faces");
        for (const member of room.members.slice(0, 3)) faces.append(avatar({ name: member.profile, displayName: member.displayName, color: bots().find(bot => bot.name === member.profile)?.color }));
        const copy = el("span", "assistant-bot-copy");
        copy.append(el("strong", "", room.name), el("small", "", room.members.map(member => member.displayName).join(", ")));
        row.append(faces, copy);
        const item = el("li");
        item.append(row);
        list.append(item);
      }
      wrap.append(list);
      return wrap;
    }

    function picker(container, onOpen) {
      const form = el("form", "assistant-routine-form");
      const name = el("input");
      const nameField = el("label", "assistant-field");
      nameField.append(el("span", "", t("groupName")), name);
      const members = el("fieldset", "assistant-routine-deliver");
      members.append(el("legend", "", t("pickMembers")));
      const boxes = bots().map(bot => {
        const wrap = el("label", "assistant-check");
        const box = el("input");
        box.type = "checkbox"; box.value = bot.name;
        wrap.append(box, el("span", "", bot.displayName));
        members.append(wrap);
        return { box, bot };
      });
      const error = el("p", "assistant-error"); error.hidden = true;
      const submit = button(t("createGroup"), "btn primary", null, "submit");
      const sync = () => { const count = boxes.filter(item => item.box.checked).length; submit.disabled = !name.value.trim() || count < 2 || count > 6; };
      for (const item of boxes) item.box.addEventListener("change", sync);
      name.addEventListener("input", sync);
      const actions = el("div", "assistant-ask-actions");
      actions.append(submit, button(t("cancel"), "btn ghost", onBack));
      form.append(el("h2", "", t("newGroup")), nameField, members, error, actions);
      form.addEventListener("submit", async event => {
        event.preventDefault();
        submit.disabled = true;
        try {
          const chosen = boxes.filter(item => item.box.checked).map(item => ({ profile: item.bot.name, displayName: item.bot.displayName }));
          onOpen((await api.createGroup(name.value.trim(), chosen)).room);
        } catch (failure) { error.textContent = t("failed", { message: failure.message }); error.hidden = false; sync(); }
      });
      sync();
      container.replaceChildren(form);
      name.focus();
    }

    function eventNode(room, event) {
      const member = room.members.find(row => row.memberId === event.memberId);
      const who = member?.displayName || event.memberId || "";
      if (event.kind === "message.user") {
        const node = el("div", "assistant-msg user");
        node.append(el("div", "assistant-bubble", event.text));
        return node;
      }
      if (event.kind === "message.member") {
        const node = el("div", "assistant-msg assistant assistant-group-message");
        const label = el("div", "assistant-group-author");
        label.append(avatar({ name: member?.profile || who, displayName: who, color: bots().find(bot => bot.name === member?.profile)?.color }), el("strong", "", who));
        node.append(label, markdown(event.text));
        return node;
      }
      const notes = { "turn.failed": t("turnFailed", { name: who }), "member.unavailable": t("memberUnavailable", { name: who }),
        "room.renamed": t("renamedTo", { name: event.name }), "room.stop_requested": t("stopRequested") };
      return notes[event.kind] ? el("div", "assistant-msg system", notes[event.kind]) : null;
    }

    function view(container, room) {
      close();
      const state = { room, cursor: 0, timers: [], working: false, approvals: [], retries: [], stopped: false };
      open = state;
      const wrap = el("section", "assistant-bot");
      const head = el("header", "assistant-bot-head");
      const back = button("‹", "btn ghost assistant-back", () => { close(); onBack(); });
      back.setAttribute("aria-label", t("back"));
      const title = el("div", "assistant-bot-title");
      const name = el("strong", "", room.name);
      title.append(name, el("small", "", room.members.map(member => `@${member.handle}`).join(" ")));
      const rename = button(t("rename"), "btn ghost", () => {
        const input = el("input", "assistant-rename");
        input.value = state.room.name;
        input.setAttribute("aria-label", t("rename"));
        const save = async () => {
          const value = input.value.trim();
          if (value && value !== state.room.name) {
            try { state.room = (await api.groupRename(room.id, value)).room || { ...state.room, name: value }; } catch (error) { toast(t("failed", { message: error.message })); }
          }
          name.textContent = state.room.name;
          input.replaceWith(name);
        };
        input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); void save(); } });
        input.addEventListener("blur", () => void save(), { once: true });
        name.replaceWith(input);
        input.focus();
      });
      let armed = false;
      const disband = button(t("disband"), "btn ghost assistant-danger", async () => {
        if (!armed) { armed = true; disband.textContent = t("confirmDisband"); setTimeout(() => { armed = false; disband.textContent = t("disband"); }, 4000); return; }
        try { await api.groupDisband(room.id); close(); onBack(); } catch (error) { toast(t("failed", { message: error.message })); }
      });
      head.append(back, title, rename, disband);
      const transcript = el("div", "assistant-transcript");
      const live = el("div", "assistant-group-live");
      const form = el("form", "assistant-composer");
      const hint = el("p", "assistant-hint assistant-group-hint", t("mentionHint"));
      const mentions = el("div", "assistant-group-mentions");
      const input = el("textarea", "assistant-input");
      input.rows = 1;
      input.placeholder = t("messageGroup");
      input.setAttribute("aria-label", t("messageGroup"));
      for (const handle of [...room.members.map(member => member.handle), "all"]) {
        mentions.append(button(`@${handle}`, "assistant-choice", () => { input.value = `${input.value.replace(/\s*$/, "")}${input.value.trim() ? " " : ""}@${handle} `; input.focus(); }));
      }
      const stop = button(t("stop"), "btn ghost assistant-stop", async () => { try { await api.groupStop(room.id); } catch (error) { toast(t("failed", { message: error.message })); } });
      const send = button(t("send"), "btn primary assistant-send", null, "submit");
      const row = el("div", "assistant-composer-row");
      row.append(input, stop, send);
      form.append(mentions, hint, row);
      form.addEventListener("submit", async event => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        send.disabled = true;
        try { await api.groupSend(room.id, text); input.value = ""; await pollLog(); } catch (error) { toast(t("failed", { message: error.message })); }
        finally { send.disabled = false; }
      });
      input.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !matchMedia("(pointer: coarse)").matches) { event.preventDefault(); form.requestSubmit(); } });
      wrap.append(head, transcript, live, form);
      container.replaceChildren(wrap);

      const renderLive = () => {
        stop.hidden = !state.working;
        live.replaceChildren();
        if (state.working && !state.approvals.length) live.append(el("p", "assistant-working", t("working")));
        for (const approval of state.approvals) {
          const member = state.room.members.find(row => row.memberId === approval.memberId);
          const card = el("section", "assistant-ask assistant-ask-approval");
          card.append(el("h3", "", t("approvalTitle", { bot: member?.displayName || approval.memberId })));
          if (approval.command) card.append(el("pre", "assistant-ask-command", approval.command));
          if (approval.description) card.append(el("p", "", approval.description));
          const actions = el("div", "assistant-ask-actions");
          for (const choice of approval.choices) {
            actions.append(button(t(choice), choice === "deny" ? "btn ghost" : "btn primary", async () => {
              for (const node of card.querySelectorAll("button")) node.disabled = true;
              try { await api.groupApprove(room.id, approval, choice); await pollState(); } catch (error) { toast(t("failed", { message: error.message })); for (const node of card.querySelectorAll("button")) node.disabled = false; }
            }));
          }
          card.append(actions);
          live.append(card);
        }
        for (const retry of state.retries) live.append(button(t("retryTurn"), "btn ghost", async () => { try { await api.groupRetry(room.id, retry.taskId); await pollState(); } catch (error) { toast(t("failed", { message: error.message })); } }));
      };
      async function pollLog() {
        if (open !== state) return;
        try {
          const page = await api.groupLog(room.id, state.cursor);
          if (open !== state) return;
          const pinned = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
          for (const event of page.events) { const node = eventNode(state.room, event); if (node) transcript.append(node); }
          state.cursor = page.cursor;
          if (pinned || page.events.length) transcript.scrollTop = transcript.scrollHeight;
          if (page.hasMore) await pollLog();
        } catch (error) { if (error.status === 404) { close(); onBack(); } }
      }
      async function pollState() {
        if (open !== state) return;
        try {
          const next = await api.groupState(room.id);
          if (open !== state) return;
          Object.assign(state, { working: next.working, approvals: next.approvals, retries: next.retries, room: next.room || state.room });
          renderLive();
        } catch {}
      }
      const tick = (fn, ms) => { const loop = async () => { if (open !== state) return; if (document.visibilityState === "visible") await fn(); if (open === state) state.timers.push(setTimeout(loop, ms)); }; void loop(); };
      renderLive();
      tick(pollLog, 1500);
      tick(pollState, 3000);
    }

    function close() {
      if (!open) return;
      for (const timer of open.timers) clearTimeout(timer);
      open = null;
    }

    async function load() { return api.groups(); }

    return Object.freeze({ load, section, view, close });
  }

  root.StepsembleAssistantGroups = Object.freeze({ create });
})(window);
```

- [ ] **Step 3: 接進助理頁**

`assistant.html`：`assistant-routines.js` 之後加 `<script src="/modules/assistant-groups.js?v=3.8.62"></script>`。

`assistant.js`：
1. 宣告區加 `groupsView = null, groupData = { supported: false, rooms: [] }`（接在 `routinesView = null` 後）。
2. `start()` 中 `routinesView = …` 之後加入：

```js
    groupsView = window.StepsembleAssistantGroups.create({ api, t, el, button, toast, M, avatar, markdown, bots: () => bots,
      onBack: () => void loadGroups().finally(showRoster) });
```

3. `start()` 的 `await loadBots();` 之後加 `await loadGroups();`，並新增：

```js
  async function loadGroups() { try { groupData = await groupsView.load(); } catch { groupData = { supported: false, rooms: [] }; } }
  function openGroup(room) { chat = null; screen = "group"; setUrl(null, null); watchNow(); groupsView.view(main, room); }
```

4. `showRoster()` 的 `wrap.append(list, button(t("signOut"), …))` 之前插入 `wrap.append(list, groupsView.section(main, groupData, openGroup));`，並把原本的 `wrap.append(list, button(...` 改成 `wrap.append(button(...`。`showRoster()` 開頭加 `groupsView?.close();`。
5. `openBot()` 開頭加 `groupsView?.close();`。

- [ ] **Step 4: 樣式**（附加到 `assistant.css`）

```css
.assistant-groups { margin-top: 20px; }
.assistant-groups h2 { margin: 0; font-size: 1rem; }
.assistant-group-faces { display: flex; flex: 0 0 auto; }
.assistant-group-faces .assistant-avatar { width: 28px; height: 28px; flex-basis: 28px; margin-right: -8px; border: 2px solid var(--paper); font-size: .75rem; }
.assistant-group-author { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.assistant-group-author .assistant-avatar { width: 22px; height: 22px; flex-basis: 22px; font-size: .7rem; }
.assistant-group-live { padding: 0 16px; }
.assistant-group-mentions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.assistant-group-hint { color: var(--pine-soft); }
```

- [ ] **Step 5:** `check:assistant` 加 `&& node --check public/modules/assistant-groups.js`；語法檢查；Commit `Show group chats on the assistant page`。

---

### Task 6: 瀏覽器測試

在 `stage = "Workspace switch";` 之前加入：

```js
      stage = "group chat";
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.getByRole("button", { name: "New group", exact: true }).click();
      await page.getByLabel("Group name").fill("Production");
      await page.getByLabel("Luna").check();
      await page.getByLabel("QA Reviewer").check();
      await page.getByRole("button", { name: "Create group", exact: true }).click();
      const groupInput = page.getByPlaceholder("Message the group");
      await groupInput.waitFor();
      await page.getByRole("button", { name: "@luna", exact: true }).click();
      await groupInput.type("what is next?");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.locator(".assistant-group-message", { hasText: "Luna heard: @luna what is next?" }).waitFor();
      assert.equal(await page.locator(".assistant-group-message", { hasText: "QA Reviewer heard" }).count(), 0, "only the mentioned Bot answers");
      const [roomId] = preview.fake.state.rooms.keys();
      preview.fake.requestGroupApproval(roomId, "default");
      await page.getByRole("button", { name: "Allow once", exact: true }).click();
      for (let tries = 0; tries < 50 && preview.fake.state.groupCalls.at(-1)?.method !== "approve"; tries += 1) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(preview.fake.state.groupCalls.at(-1).choice, "once");
      await shot("group");
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.locator(".assistant-group-row", { hasText: "Production" }).waitFor();
```

（「Back」先從例行工作分頁回到名單，再建立群組。）

Run browser cases；Commit `Test group chats on the assistant page in a browser`。

---

### Task 7: 文件與完整驗證

`docs/hermes-assistant.md` 加：「名單頁的『群組』區可以建立 2～6 個同一台機器 Bot 的群組；`@名稱` 指名、`@all` 指名全體，誰發言由 Hermes 決定。成員需要核准時卡片出現在群組裡；可停止、重試失敗的回合、改名、解散。群組開著且畫面可見時每 1.5 秒讀新訊息。」；架構段加 `server/hermes-groups.js`。`npm run check && npm test && npm run version:check`；Commit `Document group chats on the assistant page`。
