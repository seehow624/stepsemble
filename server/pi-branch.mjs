// Branches a Pi conversation after one of its replies, with Pi's own session
// code: a new session file holding the conversation up to the end of that
// reply's turn. The file it comes from is read from a copy, so it is never
// written (Pi upgrades an older file where it opens it).
//
// node pi-branch.mjs <pi package entry> <session file> <reply>
// where <reply> is id:<entry id> or ts:<message timestamp in ms>
// prints {"file": "<new session file>"}

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const [entry, file, reply = ""] = process.argv.slice(2);
const entryId = reply.startsWith("id:") ? reply.slice(3) : null;
const timestamp = reply.startsWith("ts:") ? Number(reply.slice(3)) : NaN;
const scratch = mkdtempSync(join(tmpdir(), "stepsemble-pi-branch-"));
try {
  if (!entry || !file || !entryId && !Number.isFinite(timestamp)) throw new Error("pi_branch_invalid");
  const { SessionManager } = await import(pathToFileURL(entry).href);
  const copy = join(scratch, "source.jsonl");
  copyFileSync(file, copy);
  const sessions = SessionManager.open(copy, dirname(file));
  const path = sessions.getBranch();
  const at = path.findIndex(row => row.type === "message" && row.message?.role === "assistant"
    && (entryId ? row.id === entryId : Number(row.message.timestamp) === timestamp));
  if (at < 0) throw new Error("pi_branch_reply_missing");
  // The reply's whole turn: up to the next message of the person's.
  let end = path.length - 1;
  for (let index = at + 1; index < path.length; index += 1) {
    if (path[index].type === "message" && path[index].message?.role === "user") { end = index - 1; break; }
  }
  const created = sessions.createBranchedSession(path[end].id);
  // The branch names the conversation it comes from, not the copy it was read from.
  const lines = readFileSync(created, "utf8").split("\n");
  const header = JSON.parse(lines[0]);
  if (header.type !== "session") throw new Error("pi_branch_invalid");
  header.parentSession = file;
  lines[0] = JSON.stringify(header);
  writeFileSync(created, lines.join("\n"));
  process.stdout.write(JSON.stringify({ file: created }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String(error?.message || error).slice(0, 300) }) + "\n");
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
