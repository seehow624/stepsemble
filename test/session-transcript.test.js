"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createSessionTranscripts, render, chunks, estimateTokens } = require("../server/session-transcript");
const KEY = "00000000-0000-4000-8000-0000000000aa";

function fixture(record, sources = {}) {
  const calls = [];
  const transcripts = createSessionTranscripts({
    resolve: key => key === KEY ? { key, record } : null,
    catalog: { async read(id) { calls.push(["catalog", id]); return sources.catalog?.[id] || { kind: "source_unavailable", code: "history_session_unavailable" }; } },
    readPiSession: async rel => { calls.push(["pi", rel]); if (!sources.pi?.[rel]) throw Object.assign(new Error("Session not found"), { statusCode: 404 }); return sources.pi[rel]; },
    openCode: { async messages(id, options) { calls.push(["opencode", id, options]); return { messages: sources.opencode?.[id] || [] }; } },
  });
  return { transcripts, calls };
}
const piLines = rows => rows.map(row => JSON.stringify(row)).join("\n") + "\n";

test("Pi: turns keep user words and replies, tools become one-line notes, and a compaction summary starts the record", async () => {
  const { transcripts } = fixture({ agentId: "pi", sid: "s", file: "2026/session.jsonl", name: "Fix login", cwd: "/owned/app" }, { pi: { "2026/session.jsonl": piLines([
    { type: "session_info", name: "Fix login" },
    { type: "message", id: "1", message: { role: "user", content: [{ type: "text", text: "Login sends users home" }] } },
    { type: "message", id: "2", message: { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "toolCall", id: "t", name: "read", arguments: { path: "src/auth.js" } }] } },
    { type: "message", id: "3", message: { role: "toolResult", content: [{ type: "text", text: "huge file ".repeat(5000) }] } },
    { type: "compaction", id: "4", summary: "Redirect param is lost in the OAuth callback." },
    { type: "message", id: "5", message: { role: "user", content: [{ type: "text", text: "好" }] } },
    { type: "message", id: "6", message: { role: "assistant", content: [{ type: "text", text: "Stored the URL in the session; tests pass." }] } },
  ]) } });
  const value = await transcripts.read(KEY);
  assert.equal(value.agentId, "pi"); assert.equal(value.name, "Fix login"); assert.equal(value.cwd, "/owned/app");
  assert.deepEqual(value.nativeSummary, { text: "Redirect param is lost in the OAuth callback.", throughTurn: 1 });
  assert.equal(value.turns.length, 2);
  assert.deepEqual(value.turns[0].tools, ["read src/auth.js"]);
  assert.equal(value.turns[1].user, "好"); assert.match(value.turns[1].replies.join("\n"), /tests pass/);
  const text = render(value);
  assert.doesNotMatch(text, /huge file/, "tool output is never copied");
  assert.doesNotMatch(text, /Login sends users home/, "turns the native summary covers are not repeated");
  assert.match(text, /Redirect param is lost/); assert.match(text, /Turn 2/); assert.match(text, /Stored the URL/);
  assert.ok(value.revision);
});

test("Claude Code and Codex come from the native history catalog by their own session ids", async () => {
  const claude = { kind: "native_history_transcript", name: "Review", cwd: "/owned", messages: [
    { role: "user", text: "This session is being continued from a previous conversation that ran out of context. Summary: earlier work." },
    { role: "user", text: "Check the tests" }, { role: "assistant", text: "All green." }] };
  const { transcripts, calls } = fixture({ agentId: "claude-code", nativeClaudeStructured: true, nativeSessionId: "11111111-2222-4333-8444-555555555555", cwd: "/owned" },
    { catalog: { "claude-history:11111111-2222-4333-8444-555555555555": claude } });
  const value = await transcripts.read(KEY);
  assert.equal(value.nativeSummary.text.startsWith("This session is being continued"), true); assert.equal(value.turns.length, 1); assert.equal(value.turns[0].user, "Check the tests");
  assert.deepEqual(calls, [["catalog", "claude-history:11111111-2222-4333-8444-555555555555"]]);
  const codex = fixture({ agentId: "codex", nativeCodex: true, nativeThreadId: "01a14560-d590-7732-8d1f-217819710383", cwd: "/owned" },
    { catalog: { "codex-history:01a14560-d590-7732-8d1f-217819710383": { kind: "native_history_transcript", name: "Thread", messages: [{ role: "user", text: "Ship it" }, { role: "assistant", text: "Shipped." }] } } });
  assert.equal((await codex.transcripts.read(KEY)).turns[0].replies[0], "Shipped.");
});

test("OpenCode reads the session's own messages, in its project", async () => {
  const { transcripts, calls } = fixture({ agentId: "opencode", nativeOpenCode: true, nativeSessionId: "ses_1", cwd: "/owned" }, { opencode: { ses_1: [
    { role: "user", parts: [{ type: "text", text: "Explore" }] },
    { role: "assistant", parts: [{ type: "tool", tool: "read", callID: "c", state: { status: "completed", input: { filePath: "/owned/a.js" }, output: "x".repeat(9000) } }, { type: "text", text: "Done exploring." }] },
  ] } });
  const value = await transcripts.read(KEY);
  assert.equal(value.turns[0].user, "Explore"); assert.deepEqual(value.turns[0].replies, ["Done exploring."]); assert.match(value.turns[0].tools[0], /read/);
  assert.deepEqual(calls[0], ["opencode", "ses_1", { directory: "/owned" }]);
});

test("sessions without a readable history are refused before any read", async () => {
  for (const record of [{ agentId: "hermes", nativeAcp: true }, { agentId: "antigravity" }, { agentId: "codex" }]) {
    const { transcripts, calls } = fixture(record);
    await assert.rejects(transcripts.read(KEY), error => error.code === "reference_source_unavailable");
    assert.deepEqual(calls, []);
  }
  const { transcripts } = fixture({ agentId: "pi", file: "x" });
  await assert.rejects(transcripts.read("bad"), error => error.statusCode === 400);
  await assert.rejects(transcripts.read("00000000-0000-4000-8000-0000000000ff"), error => error.statusCode === 404);
});

test("long records split into ordered chunks within the budget, and token estimates are conservative", () => {
  const value = { agentId: "pi", name: "Long", cwd: "/p", nativeSummary: null, turns: Array.from({ length: 40 }, (_, i) => ({ index: i + 1, user: "u".repeat(3000), replies: ["r".repeat(3000)], tools: [] })) };
  const parts = chunks(value, { maxChars: 20000 });
  assert.ok(parts.length > 1);
  assert.ok(parts.every(part => part.text.length <= 20000 + 6000), "a chunk only exceeds its budget by at most one turn");
  assert.deepEqual(parts.flatMap(part => part.turns), Array.from({ length: 40 }, (_, i) => i + 1), "every turn appears once, in order");
  assert.ok(estimateTokens("中文字".repeat(100)) >= 300, "CJK counts about one token per character");
  assert.ok(estimateTokens("word ".repeat(400)) >= 400);
});

test("the plain digest lists each turn's request, the files touched and the last reply, without a model", () => {
  const { digest } = require("../server/session-transcript");
  const value = { agentId: "pi", name: "Fix login", cwd: "/owned", nativeSummary: { text: "Earlier: found the lost redirect.", throughTurn: 1 }, turns: [
    { index: 1, user: "Login sends users home\nwith details", replies: ["Looking."], tools: ["read src/auth.js"] },
    { index: 2, user: "好", replies: ["Edited.", "Stored the URL in the session; tests pass."], tools: ["edit src/auth.js", "bash npm test", "read test/login.test.js"] },
  ] };
  const text = digest(value);
  assert.match(text, /Earlier: found the lost redirect\./); assert.match(text, /1\. Login sends users home/); assert.doesNotMatch(text, /with details/);
  assert.match(text, /2\. 好/); assert.match(text, /src\/auth\.js/); assert.match(text, /test\/login\.test\.js/); assert.doesNotMatch(text, /npm test/, "commands are not files");
  assert.match(text, /Stored the URL in the session; tests pass\./); assert.doesNotMatch(text, /Looking\./);
});

const piEntry = (id, parentId, role, text, extra = {}) => ({ type: "message", id, parentId, message: { role, content: [{ type: "text", text }] }, ...extra });
test("Pi: the turns a compaction kept are sent in full, and only the turns before its kept boundary count as summarized", async () => {
  const { transcripts } = fixture({ agentId: "pi", file: "kept.jsonl" }, { pi: { "kept.jsonl": piLines([
    { type: "session", id: "s" },
    piEntry("u1", null, "user", "Old request"), piEntry("a1", "u1", "assistant", "Old answer"),
    piEntry("u2", "a1", "user", "Recent request the compaction kept"), piEntry("a2", "u2", "assistant", "Recent answer it kept"),
    { type: "compaction", id: "c1", parentId: "a2", summary: "Earlier: the old request.", firstKeptEntryId: "u2", tokensBefore: 9000 },
  ]) } });
  const value = await transcripts.read(KEY);
  assert.deepEqual(value.nativeSummary, { text: "Earlier: the old request.", throughTurn: 1 });
  const text = render(value);
  assert.match(text, /Recent request the compaction kept/); assert.match(text, /Recent answer it kept/); assert.doesNotMatch(text, /Old answer/);
  assert.equal(chunks(value, { maxChars: 120000 }).length, 1, "the kept turn still needs summarizing");
});

test("Pi: only the active branch is read; an abandoned branch and its compaction stay out", async () => {
  const { transcripts } = fixture({ agentId: "pi", file: "tree.jsonl" }, { pi: { "tree.jsonl": piLines([
    { type: "session", id: "s" },
    piEntry("u1", null, "user", "Start"), piEntry("a1", "u1", "assistant", "Two ways to go"),
    piEntry("u2", "a1", "user", "Try the abandoned way"), piEntry("a2", "u2", "assistant", "Abandoned work"),
    { type: "compaction", id: "c-old", parentId: "a2", summary: "Summary of the abandoned branch", firstKeptEntryId: "u2" },
    { type: "branch_summary", id: "b1", parentId: "a1", summary: "Tried the other way; it broke the tests.", fromId: "c-old" },
    piEntry("u3", "b1", "user", "Take the kept way"), piEntry("a3", "u3", "assistant", "Kept work"),
  ]) } });
  const value = await transcripts.read(KEY);
  const text = render(value);
  assert.deepEqual(value.turns.map(turn => turn.user), ["Start", "Take the kept way"]);
  assert.doesNotMatch(text, /Abandoned work|Summary of the abandoned branch/); assert.equal(value.nativeSummary, null);
  assert.match(text, /Tried the other way; it broke the tests\./, "the branch summary on the path is kept as context");
});

test("Pi: a compaction that kept nothing covers every turn before it", async () => {
  const { transcripts } = fixture({ agentId: "pi", file: "none.jsonl" }, { pi: { "none.jsonl": piLines([
    { type: "session", id: "s" }, piEntry("u1", null, "user", "Request"), piEntry("a1", "u1", "assistant", "Answer"),
    { type: "compaction", id: "c1", parentId: "a1", summary: "All of it.", firstKeptEntryId: "c1" },
  ]) } });
  const value = await transcripts.read(KEY);
  assert.deepEqual(value.nativeSummary, { text: "All of it.", throughTurn: 1 }); assert.equal(chunks(value, { maxChars: 120000 }).length, 0);
});

test("Claude Code: the catalog's tool calls join the reply they follow, so the digest can list the files", async () => {
  const { digest } = require("../server/session-transcript");
  const id = "11111111-2222-4333-8444-555555555555";
  const { transcripts } = fixture({ agentId: "claude-code", nativeSessionId: id, cwd: "/owned" }, { catalog: { [`claude-history:${id}`]: {
    kind: "native_history_transcript", messages: [{ role: "user", text: "Fix the login redirect" }, { role: "assistant", text: "Looking." }, { role: "assistant", text: "Fixed." }],
    tools: [{ name: "Read", input: { file_path: "/owned/src/auth.js" }, output: "x".repeat(5000), after: 1 }, { name: "Edit", input: { file_path: "/owned/src/auth.js" }, after: 2 },
      { name: "Bash", input: { command: "npm test" }, after: 2 }, { name: "Read", input: { file_path: "/owned/early.js" }, after: 0 }] } } });
  const value = await transcripts.read(KEY);
  assert.deepEqual(value.turns[0].tools, ["Read /owned/src/auth.js", "Edit /owned/src/auth.js", "Bash npm test"]);
  assert.deepEqual(value.turns[0].replies, ["Looking.", "Fixed."]);
  assert.doesNotMatch(render(value), /xxxx/, "tool output is never copied");
  assert.match(digest(value), /Files touched:\n- \/owned\/src\/auth\.js/);
});

test("a long Claude Code history is read back page by page to its start, each tool call in its turn", { skip: process.platform === "win32" }, async t => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const { createNativeHistoryCatalog } = require("../server/native-history-catalog");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-handoff-pages-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const id = "11111111-2222-4333-8444-555555555555", project = path.join(home, ".claude", "projects", "-owned");
  fs.mkdirSync(project, { recursive: true, mode: 0o755 });
  const rows = [];
  for (let index = 1; index <= 5; index++) rows.push(
    { type: "user", uuid: `u${index}`, timestamp: `2026-10-0${index}T09:00:00Z`, message: { role: "user", content: `Request ${index}` } },
    { type: "assistant", uuid: `t${index}`, timestamp: `2026-10-0${index}T09:00:01Z`, message: { id: `m${index}`, content: [{ type: "tool_use", id: `tool${index}`, name: "Read", input: { file_path: `/owned/${index}.js` } }] } },
    { type: "assistant", uuid: `a${index}`, timestamp: `2026-10-0${index}T09:00:02Z`, message: { id: `n${index}`, content: [{ type: "text", text: `Reply ${index}` }] } });
  fs.writeFileSync(path.join(project, `${id}.jsonl`), rows.map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  // Two messages a page: the record comes in five pages.
  const catalog = createNativeHistoryCatalog({ home, limits: { pageMessages: 2 } });
  t.after(() => catalog.shutdown());
  const transcripts = createSessionTranscripts({ resolve: key => key === KEY ? { key, record: { agentId: "claude-code", nativeSessionId: id, cwd: "/owned" } } : null,
    catalog, readPiSession: async () => { throw new Error("unused"); }, openCode: {} });
  const value = await transcripts.read(KEY);
  assert.deepEqual(value.turns.map(turn => [turn.user, turn.replies, turn.tools]),
    [1, 2, 3, 4, 5].map(index => [`Request ${index}`, [`Reply ${index}`], [`Read /owned/${index}.js`]]));
});

test("a page that no longer joins the newer one ends the record there", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const pages = {
    null: { kind: "native_history_transcript", messages: [{ role: "user", text: "Newest" }, { role: "assistant", text: "Latest reply." }], before: 4, end: 6, sourceVersion: "v1" },
    4: { kind: "native_history_transcript", messages: [{ role: "user", text: "Rewritten" }], before: null, end: 3, sourceVersion: "v2" },
  };
  const reads = [];
  const transcripts = createSessionTranscripts({ resolve: key => key === KEY ? { key, record: { agentId: "claude-code", nativeSessionId: id, cwd: "/owned" } } : null,
    catalog: { async read(taskId, { before = null } = {}) { reads.push(before); return pages[before]; } }, readPiSession: async () => "", openCode: {} });
  const value = await transcripts.read(KEY);
  assert.deepEqual(reads, [null, 4]);
  assert.deepEqual(value.turns.map(turn => turn.user), ["Newest"]);
});
