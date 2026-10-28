"use strict";
// agy's own list of its conversations (conversation_summaries.db), read from a
// private copy while agy holds it open, and the match of a conversation
// Stepsemble 3.10.0 opened to agy's own.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { readAntigravityConversations, matchStreamEntries } = require("../server/antigravity-history");

const ID = n => `${String(n).repeat(8)}-1111-4222-8333-${String(n).repeat(12)}`;

test("agy's conversations are read while agy holds its list open, without a subagent's, an empty one or Stepsemble's gate", async t => {
  const { DatabaseSync } = require("node:sqlite");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-agy-history-test-"));
  const project = path.join(home, "project"), gate = path.join(home, "config", "antigravity-gate");
  const db = new DatabaseSync(path.join(home, "conversation_summaries.db"));
  t.after(() => { try { db.close(); } catch {} fs.rmSync(home, { recursive: true, force: true }); });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE conversation_summaries (conversation_id text, title text NOT NULL DEFAULT "", preview text NOT NULL DEFAULT "",
      step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL, workspace_uris text NOT NULL,
      parent_conversation_id text NOT NULL DEFAULT "", nesting_depth integer NOT NULL DEFAULT 0, PRIMARY KEY (conversation_id));`);
  const add = db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const uri = folder => JSON.stringify([pathToFileURL(folder).href]);
  add.run(ID(1), "", "fix the build\nand more", 4, "2026-10-28 01:46:56.505768+00:00", uri(project), "", 0);
  add.run(ID(2), "Named one", "", 2, "2026-10-27 01:00:00+00:00", JSON.stringify([pathToFileURL(gate).href, pathToFileURL(project).href]), "", 0);
  add.run(ID(3), "", "a subagent", 2, "2026-10-28 02:00:00+00:00", uri(project), ID(1), 1);
  add.run(ID(4), "", "", 0, "0001-01-01 00:00:00+00:00", uri(project), "", 0);
  add.run(ID(5), "", "only the gate", 2, "2026-10-28 03:00:00+00:00", uri(gate), "", 0);
  add.run("not-an-id", "", "x", 2, "2026-10-28 03:00:00+00:00", uri(project), "", 0);
  // Still in the WAL, as while agy runs.
  assert.ok(fs.statSync(path.join(home, "conversation_summaries.db-wal")).size > 0);
  const rows = await readAntigravityConversations({ agyHome: home, exclude: [gate] });
  assert.deepEqual(rows, [
    { id: ID(1), cwd: project, name: "fix the build", lastActivityAt: Date.parse("2026-10-28T01:46:56.505Z"), turns: 4 },
    { id: ID(2), cwd: project, name: "Named one", lastActivityAt: Date.parse("2026-10-27T01:00:00Z"), turns: 2 },
  ]);
  assert.deepEqual(fs.readdirSync(home).sort(), ["conversation_summaries.db", "conversation_summaries.db-shm", "conversation_summaries.db-wal"], "agy's files only read");
  assert.deepEqual(await readAntigravityConversations({ agyHome: path.join(home, "missing") }), []);
});

test("a conversation from 3.10.0 is matched to the agy conversation that began after it was opened, once", () => {
  const minute = 60_000, at = Date.parse("2026-10-28T01:46:31Z");
  const began = { [ID(1)]: at + 25_000, [ID(2)]: at + 30 * minute, [ID(3)]: at - 5 * minute, [ID(4)]: at + 2 * minute, [ID(5)]: at + 26 * 60 * minute };
  const conversations = [ID(1), ID(2), ID(3), ID(5)].map(id => ({ id, cwd: "/p" })).concat({ id: ID(4), cwd: "/other" });
  const matches = matchStreamEntries({ conversations, began: id => began[id] ?? null,
    entries: [{ key: "first", addedAt: at, cwd: "/p" }, { key: "second", addedAt: at + 20 * minute, cwd: "/p" }, { key: "far", addedAt: at, cwd: "/elsewhere" }] });
  assert.deepEqual(matches, [{ key: "first", id: ID(1) }, { key: "second", id: ID(2) }]);
  // One already continued in the bridge is not taken again; one begun before
  // the entry was opened, or a day after, is not its conversation.
  assert.deepEqual(matchStreamEntries({ conversations, claimed: [ID(1)], began: id => began[id] ?? null,
    entries: [{ key: "first", addedAt: at, cwd: "/p" }] }), [{ key: "first", id: ID(2) }]);
  assert.deepEqual(matchStreamEntries({ conversations: [{ id: ID(3), cwd: "/p" }, { id: ID(5), cwd: "/p" }], began: id => began[id] ?? null,
    entries: [{ key: "first", addedAt: at, cwd: "/p" }] }), []);
});
