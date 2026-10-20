"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createNativeHistoryCatalog, recordsFromBytes } = require("../server/native-history-catalog");

const CLAUDE_ID = "11111111-1111-4111-8111-111111111111";
const CODEX_ID = "22222222-2222-4222-8222-222222222222";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-native-history-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, ".claude", "projects", "-Users-test"), { recursive: true, mode: 0o755 });
  await fs.mkdir(path.join(home, ".codex", "sessions", "2026", "09", "13"), { recursive: true, mode: 0o755 });
  await fs.mkdir(path.join(home, ".codex", "archived_sessions"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(home, ".claude", "projects", "-Users-test", `${CLAUDE_ID}.jsonl`), [
    { type: "user", sessionId: CLAUDE_ID, timestamp: "2026-09-13T10:00:00.000Z", cwd: "/Users/test", message: { role: "user", content: "Fix the widget" } },
    { type: "ai-title", sessionId: CLAUDE_ID, aiTitle: "Widget repair" },
    { type: "assistant", sessionId: CLAUDE_ID, timestamp: "2026-09-13T10:00:01.000Z", message: { id: "msg_widget_1", role: "assistant", model: "claude-test", content: [{ type: "text", text: "I will inspect it." }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  const codexFile = path.join(home, ".codex", "sessions", "2026", "09", "13", `rollout-2026-09-13T18-00-00-${CODEX_ID}.jsonl`);
  await fs.writeFile(codexFile, [
    { timestamp: "2026-09-13T10:00:00.000Z", ordinal: 0, type: "session_meta", payload: { id: CODEX_ID, session_id: CODEX_ID, cwd: "/Users/test", cli_version: "0.154.0-alpha.6.2" } },
    { timestamp: "2026-09-13T10:00:01.000Z", ordinal: 1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Review the widget" }] } },
    { timestamp: "2026-09-13T10:00:02.000Z", ordinal: 2, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "The widget is ready." }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  await fs.writeFile(path.join(home, ".codex", "history.jsonl"), JSON.stringify({ session_id: CODEX_ID, ts: 1789293600, text: "Review the widget" }) + "\n", { mode: 0o600 });
  // A valid-looking JSONL file outside Codex's rollout roots must not become
  // a history row merely because it lives below ~/.codex.
  await fs.writeFile(path.join(home, ".codex", "credentials.jsonl"), JSON.stringify({
    type: "session_meta", payload: { id: "33333333-3333-4333-8333-333333333333", cwd: "/private" },
  }) + "\n", { mode: 0o600 });
  return { home, codexFile };
}

async function startHost(t, home) {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PI_HOME: home,
    PATH: [path.dirname(process.execPath), process.env.PATH || ""].join(path.delimiter),
    PI_BIN: process.execPath,
    STEPSEMBLE_TOKEN: "native-history-test-token",
    STEPSEMBLE_PORT: String(port),
    STEPSEMBLE_HOST: "127.0.0.1",
    STEPSEMBLE_SECURE_COOKIE: "0",
    STEPSEMBLE_ORPHAN_EXIT: "0",
  };
  const child = spawn(process.execPath, [path.resolve(__dirname, "../server.js")], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume(); child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, "close");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await done;
      clearTimeout(timer);
    }
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 500; i++) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.status === 200) return { base, async request(route, options = {}) { return fetch(base + route, options); } };
    } catch {}
    if (child.exitCode !== null) throw new Error("native history fixture host exited");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("native history fixture host did not become ready");
}

// Reading provider transcripts requires POSIX ownership and mode checks, so the
// catalog reports itself unsupported on Windows instead of reading those files.
const posixOnly = { skip: process.platform === "win32" ? "native history catalog is POSIX-only" : false };

test("catalogs Claude Code and Codex local history without launching either harness", posixOnly, async t => {
  const { home } = await fixture(t);
  const catalog = createNativeHistoryCatalog({ home });
  t.after(() => catalog.shutdown());
  const tasks = await catalog.listTasks();
  assert.deepEqual(tasks.map(row => row.agentId).sort(), ["claude-code", "codex"]);
  assert.equal(tasks.some(row => row.nativeHistorySessionId === "33333333-3333-4333-8333-333333333333"), false);
  assert.ok(tasks.every(row => row.nativeHistoryReadonly === true && row.readOnly === true));
  assert.equal(tasks.find(row => row.agentId === "claude-code").name, "Widget repair");
  assert.ok(tasks.every(row => !Object.values(row).some(value => typeof value === "string" && value.includes(".claude"))));
  const claude = await catalog.read(`claude-history:${CLAUDE_ID}`);
  assert.equal(claude.kind, "native_history_transcript");
  assert.equal(claude.messages[0].text, "Fix the widget");
  // A live view skips the replies this history already shows by their id.
  assert.equal(claude.messages[0].id, undefined);
  assert.equal(claude.messages.at(-1).id, "msg_widget_1");
  const codex = await catalog.read(`codex-history:${CODEX_ID}`);
  assert.equal(codex.messages.at(-1).text, "The widget is ready.");
});

test("catalog rejects arbitrary paths and malformed/oversized transcript bytes", async t => {
  const { home } = await fixture(t);
  const catalog = createNativeHistoryCatalog({ home });
  t.after(() => catalog.shutdown());
  assert.equal((await catalog.read("claude-history:../../etc/passwd")).code, "history_session_invalid");
  assert.equal(recordsFromBytes(Buffer.from("not-json\n")).code, "source_invalid_json");
  assert.equal(recordsFromBytes(Buffer.from("{\"ok\":true}")).kind, "source_records");
});

// The POSIX-only boundary must be an explicit, visible refusal rather than an
// empty list that looks like the user simply has no saved conversations.
test("Windows reports the catalog as unsupported instead of silently empty",
  { skip: process.platform !== "win32" ? "Windows-only boundary" : false }, async t => {
    const { home } = await fixture(t);
    const catalog = createNativeHistoryCatalog({ home });
    t.after(() => catalog.shutdown());
    assert.deepEqual(await catalog.listTasks(), []);
    assert.equal(catalog.status().enabled, false);
    assert.equal(catalog.status().lastError, "platform_unsupported");
  });

test("catalog refresh is bounded and cached", posixOnly, async t => {
  const { home } = await fixture(t);
  const catalog = createNativeHistoryCatalog({ home, clock: () => 1000 });
  t.after(() => catalog.shutdown());
  await catalog.listTasks();
  const first = catalog.status();
  await catalog.listTasks();
  assert.equal(catalog.status().lastRefresh, first.lastRefresh);
  assert.equal(catalog.status().refreshing, false);
});

test("authenticated HTTP exposes native history without exposing paths or mutation", posixOnly, async t => {
  const { home } = await fixture(t);
  const host = await startHost(t, home);
  const login = await host.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "native-history-test-token" }) });
  assert.equal(login.status, 204);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const tasksResponse = await host.request("/api/agent-tasks", { headers: { cookie } });
  assert.equal(tasksResponse.status, 200);
  const tasks = (await tasksResponse.json()).tasks;
  const claude = tasks.find(row => row.id === `claude-history:${CLAUDE_ID}`);
  const codex = tasks.find(row => row.id === `codex-history:${CODEX_ID}`);
  assert.ok(claude && codex);
  assert.equal(claude.readOnly, true); assert.equal(codex.nativeHistoryReadonly, true);
  assert.ok(!JSON.stringify(tasks).includes(".claude"));
  const transcript = await host.request(`/api/native-history/session?taskId=${encodeURIComponent(codex.id)}`, { headers: { cookie } });
  assert.equal(transcript.status, 200);
  assert.equal((await transcript.json()).messages.at(-1).text, "The widget is ready.");
  assert.equal((await host.request(`/api/native-history/session?taskId=${encodeURIComponent(codex.id)}`)).status, 401);
  assert.equal((await host.request(`/api/native-history/session?taskId=${encodeURIComponent("../../etc/passwd")}`, { headers: { cookie } })).status, 400);
  // An older page is asked for by the row the newer one starts at.
  const session = query => host.request(`/api/native-history/session?taskId=${encodeURIComponent(claude.id)}${query}`, { headers: { cookie } });
  const newest = await (await session("&limit=1")).json();
  assert.deepEqual([newest.messages.map(message => message.text), newest.hasMore, newest.before], [["I will inspect it."], true, 1]);
  const older = await (await session(`&limit=1&before=${newest.before}`)).json();
  assert.deepEqual([older.messages.map(message => message.text), older.hasMore, older.before, older.end], [["Fix the widget"], false, null, 1]);
  assert.equal(older.sourceVersion, newest.sourceVersion);
  assert.deepEqual((await (await session("&limit=5&tools=0")).json()).messages.map(message => message.text), ["Fix the widget", "I will inspect it."]);
  assert.equal((await session("&before=-1")).status, 400);
  assert.equal((await session("&limit=many")).status, 400);
});

const day = (date, second = 0) => `2026-10-${date}T09:00:${String(second).padStart(2, "0")}.000Z`;
const claudeRow = (type, uuid, at, content, extra = {}) => ({ type, uuid, sessionId: CLAUDE_ID, cwd: "/Users/test", timestamp: at,
  message: { role: type, content, ...(type === "assistant" ? { id: "msg_" + uuid, model: "claude-test" } : {}) }, ...extra });
const jsonl = rows => rows.map(row => JSON.stringify(row)).join("\n") + "\n";

async function claudeFixture(t, rows) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-claude-pages-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const project = path.join(home, ".claude", "projects", "-Users-test");
  await fs.mkdir(project, { recursive: true, mode: 0o755 });
  const file = path.join(project, `${CLAUDE_ID}.jsonl`);
  await fs.writeFile(file, jsonl(rows), { mode: 0o600 });
  return { home, project, file };
}

// Every page from the newest back, refusing one that does not end where the
// newer page starts.
async function allPages(catalog, taskId, limit) {
  const pages = [];
  let before = null;
  do {
    const page = await catalog.read(taskId, { before, limit });
    assert.equal(page.kind, "native_history_transcript", page.code);
    if (pages.length) assert.equal(page.end, before, "an older page ends where the newer one starts");
    if (pages.length) assert.equal(page.sourceVersion, pages[0].sourceVersion);
    pages.push(page);
    before = page.before;
  } while (before !== null && pages.length < 100);
  return pages.reverse();
}

test("a transcript far past what one page holds comes back whole, page by page, oldest day first", posixOnly, async t => {
  // Days 1, 3 and 5 between tool results much larger than everything the
  // catalog keeps of them; it keeps too little to hold the whole transcript.
  const rows = [];
  for (const date of ["01", "03", "05"]) {
    rows.push(claudeRow("user", `u${date}`, day(date), `Question on day ${date}`));
    for (let index = 0; index < 4; index++) {
      const id = `toolu_${date}_${index}`;
      rows.push(claudeRow("assistant", `a${date}${index}`, day(date, index + 1), [{ type: "tool_use", id, name: "Read", input: { file_path: `/tmp/${date}-${index}` } }]));
      rows.push(claudeRow("user", `r${date}${index}`, day(date, index + 1), [{ type: "tool_result", tool_use_id: id, content: `day ${date} `.repeat(80_000) }]));
    }
    rows.push(claudeRow("assistant", `z${date}`, day(date, 9), [{ type: "text", text: `Answer on day ${date}` }]));
  }
  const { home, file } = await claudeFixture(t, rows);
  assert.ok((await fs.stat(file)).size > 4 * 1024 * 1024);
  const parses = [];
  const catalog = createNativeHistoryCatalog({ home, onParse: pass => parses.push(pass),
    limits: { pageToolBytes: 80 * 1024, retainedBytes: 160 * 1024, chunkBytes: 64 * 1024 } });
  t.after(() => catalog.shutdown());
  const pages = await allPages(catalog, `claude-history:${CLAUDE_ID}`, 2);
  assert.ok(pages.length >= 3, `${pages.length} pages`);
  assert.deepEqual(pages.flatMap(page => page.messages.map(message => message.text)), ["01", "03", "05"].flatMap(date => [`Question on day ${date}`, `Answer on day ${date}`]));
  const tools = pages.flatMap(page => page.tools);
  assert.deepEqual(tools.map(tool => tool.input.file_path), ["01", "03", "05"].flatMap(date => [0, 1, 2, 3].map(index => `/tmp/${date}-${index}`)));
  assert.ok(tools.every(tool => tool.output.startsWith("day ") && tool.endedAt), "every tool keeps its result");
  assert.ok(pages.every(page => page.truncated === false), "nothing was left out, only paged");
  // Each tool sits before the message it came before, on its own page.
  for (const page of pages) for (const tool of page.tools) assert.ok(tool.after >= 0 && tool.after <= page.messages.length);
  assert.ok(parses.some(pass => pass.once), "rows the catalog let go of were read again from the file");
  assert.equal(parses.filter(pass => !pass.once).length, 1, "the transcript itself was read once");
  // A preview of the words leaves the tool calls out.
  const words = await catalog.read(`claude-history:${CLAUDE_ID}`, { limit: 2, tools: false });
  assert.deepEqual([words.tools, words.messages.map(message => message.text)], [[], ["Question on day 05", "Answer on day 05"]]);
});

test("a line too long or unreadable is left out, and only the page it sits in says so", posixOnly, async t => {
  const { home, file } = await claudeFixture(t, [claudeRow("user", "u1", day("01"), "Before the long line")]);
  await fs.appendFile(file, JSON.stringify(claudeRow("user", "u2", day("01", 1), "x".repeat(4096))) + "\nnot json\n"
    + jsonl([claudeRow("assistant", "a1", day("01", 2), [{ type: "text", text: "After it" }]), claudeRow("user", "u3", day("01", 3), "Newest")]));
  const catalog = createNativeHistoryCatalog({ home, limits: { lineBytes: 1024, chunkBytes: 4096 } });
  t.after(() => catalog.shutdown());
  const newest = await catalog.read(`claude-history:${CLAUDE_ID}`, { limit: 1 });
  assert.deepEqual([newest.messages.map(message => message.text), newest.truncated, newest.omittedRecords], [["Newest"], false, 2]);
  const older = await catalog.read(`claude-history:${CLAUDE_ID}`, { before: newest.before });
  assert.deepEqual([older.messages.map(message => message.text), older.truncated], [["Before the long line", "After it"], true]);
});

test("a Claude subagent's transcript never stands in for the conversation it belongs to", posixOnly, async t => {
  const main = [
    claudeRow("user", "u1", day("01"), "Main question"),
    claudeRow("assistant", "a1", day("01", 1), [{ type: "text", text: "Main answer" }]),
    claudeRow("user", "u2", day("01", 2), "Main follow-up"),
  ];
  const { home, project, file } = await claudeFixture(t, main);
  const sidechain = [
    claudeRow("user", "s1", day("02"), "Subagent prompt", { isSidechain: true, agentId: "x" }),
    claudeRow("assistant", "s2", day("02", 1), [{ type: "text", text: "Subagent answer" }], { isSidechain: true, agentId: "x" }),
  ];
  const subagents = path.join(project, CLAUDE_ID, "subagents");
  await fs.mkdir(subagents, { recursive: true, mode: 0o755 });
  await fs.writeFile(path.join(subagents, "agent-x.jsonl"), jsonl(sidechain), { mode: 0o600 });
  // An older Claude Code kept a sidechain beside the conversations, and a
  // file named otherwise is not a conversation either.
  await fs.writeFile(path.join(project, "33333333-3333-4333-8333-333333333333.jsonl"), jsonl(sidechain), { mode: 0o600 });
  await fs.writeFile(path.join(project, "notes.jsonl"), jsonl(main.map(row => ({ ...row, sessionId: "44444444-4444-4444-8444-444444444444" }))), { mode: 0o600 });
  const old = new Date("2026-10-01T00:00:00Z");
  await fs.utimes(file, old, old);
  const catalog = createNativeHistoryCatalog({ home });
  t.after(() => catalog.shutdown());
  const tasks = await catalog.listTasks();
  assert.deepEqual(tasks.map(task => task.id), [`claude-history:${CLAUDE_ID}`]);
  const read = await catalog.read(`claude-history:${CLAUDE_ID}`);
  assert.deepEqual(read.messages.map(message => message.text), ["Main question", "Main answer", "Main follow-up"]);
});

test("a transcript read again is read on from where the last read stopped, and from its start when it was replaced", posixOnly, async t => {
  const { home, file } = await claudeFixture(t, [
    claudeRow("user", "u1", day("01"), "First question"),
    claudeRow("assistant", "a1", day("01", 1), [{ type: "text", text: "First answer" }]),
  ]);
  const parses = [];
  const catalog = createNativeHistoryCatalog({ home, onParse: pass => parses.push(pass) });
  t.after(() => catalog.shutdown());
  const taskId = `claude-history:${CLAUDE_ID}`;
  const first = await catalog.read(taskId);
  const size = (await fs.stat(file)).size;
  assert.deepEqual(parses, [{ from: 0, to: size }]);
  // Unchanged: nothing is read again.
  await catalog.read(taskId);
  assert.equal(parses.length, 1);
  // A line still being written waits for the rest of it.
  const next = jsonl([claudeRow("user", "u2", day("02"), "Second question"), claudeRow("assistant", "a2", day("02", 1), [{ type: "text", text: "Second answer" }])]);
  await fs.appendFile(file, next.slice(0, -40));
  const partial = await catalog.read(taskId);
  assert.deepEqual(partial.messages.map(message => message.text), ["First question", "First answer", "Second question"]);
  await fs.appendFile(file, next.slice(-40));
  const grown = await catalog.read(taskId);
  assert.deepEqual(grown.messages.map(message => message.text), ["First question", "First answer", "Second question", "Second answer"]);
  assert.ok(parses.slice(1).every(pass => pass.from >= size), JSON.stringify(parses));
  assert.equal(grown.sourceVersion, first.sourceVersion);
  // Rewritten shorter in place: read again from its start, with new row numbers.
  await fs.writeFile(file, jsonl([claudeRow("user", "u9", day("09"), "Rewritten question")]));
  const rewritten = await catalog.read(taskId);
  assert.deepEqual(rewritten.messages.map(message => message.text), ["Rewritten question"]);
  assert.equal(parses.at(-1).from, 0);
  assert.notEqual(rewritten.sourceVersion, first.sourceVersion);
});

test("the composer's model, effort and context come from the last turn that states them", posixOnly, async t => {
  const usage = (input, cached, created, output) => ({ input_tokens: input, cache_read_input_tokens: cached, cache_creation_input_tokens: created, output_tokens: output });
  const { home } = await claudeFixture(t, [
    claudeRow("user", "u1", day("01"), "Question"),
    { ...claudeRow("assistant", "a1", day("01", 1), [{ type: "text", text: "Early" }]), requestedModel: "claude-older", effort: "high", perTurnEffort: "high",
      message: { id: "msg_a1", role: "assistant", model: "claude-older", content: [{ type: "text", text: "Early" }], usage: usage(1, 2, 3, 4) } },
    { ...claudeRow("assistant", "a2", day("01", 2), [{ type: "text", text: "Late" }]), requestedModel: "claude/claude-test:xhigh[1m]", effort: "high", perTurnEffort: "xhigh",
      message: { id: "msg_a2", role: "assistant", model: "claude-test", content: [{ type: "text", text: "Late" }], usage: usage(2, 700_000, 600, 400) } },
    claudeRow("assistant", "s1", day("01", 3), [{ type: "text", text: "No response requested." }], { message: { id: "s1", role: "assistant", model: "<synthetic>",
      content: [{ type: "text", text: "No response requested." }], usage: usage(0, 0, 0, 0) } }),
  ]);
  const catalog = createNativeHistoryCatalog({ home });
  t.after(() => catalog.shutdown());
  const claude = await catalog.read(`claude-history:${CLAUDE_ID}`);
  assert.deepEqual(claude.composer, { model: "claude-test", effort: "xhigh", contextTokens: 701_002, contextWindow: 1_000_000, observedAt: Date.parse(day("01", 2)) });
  // A branch's composer is the conversation's at the branch.
  const branch = await catalog.read(`claude-history:${CLAUDE_ID}`, { through: "a1" });
  assert.deepEqual(branch.composer, { model: "claude-older", effort: "high", contextTokens: 10, contextWindow: null, observedAt: Date.parse(day("01", 1)) });

  const { home: codexHome, codexFile } = await fixture(t);
  await fs.appendFile(codexFile, jsonl([
    { timestamp: "2026-09-13T10:00:03.000Z", type: "turn_context", payload: { model: "gpt-test", effort: "medium" } },
    { timestamp: "2026-09-13T10:00:04.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 1234 }, model_context_window: 272_000 } } },
  ]));
  const codexCatalog = createNativeHistoryCatalog({ home: codexHome });
  t.after(() => codexCatalog.shutdown());
  const codex = await codexCatalog.read(`codex-history:${CODEX_ID}`);
  assert.deepEqual(codex.composer, { model: "gpt-test", effort: "medium", contextTokens: 1234, contextWindow: 272_000, observedAt: Date.parse("2026-09-13T10:00:04.000Z") });
  assert.equal(codex.messages.at(-1).text, "The widget is ready.");
});
