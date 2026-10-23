"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { unknownSpeed, speedValue } = require("./agent-speed");
const COMMAND = "stepsemble-speed";
// get_entries without a cursor returns the whole conversation on one line,
// screenshots and all: tens of MB in a long one, past the RPC frame limit, and
// the Host then ends Pi. Only a list this small is ever read whole.
const FULL_ENTRIES_BYTES = 8 * 1024 * 1024, TAIL_CHUNK = 1024 * 1024, LINE_LIMIT = 16 * 1024 * 1024;
// The id of the last complete entry Pi wrote to its session file, and the
// file's size. A partial last line is still being written and is skipped. No
// file (a conversation Pi has not saved yet) or no readable line: no id.
async function lastEntryId(file) {
  const none = { id: null, size: 0 };
  if (typeof file !== "string" || !path.isAbsolute(file) || !file.endsWith(".jsonl")) return none;
  let handle;
  try { handle = await fs.promises.open(file, "r"); } catch { return none; }
  try {
    const { size } = await handle.stat();
    let tail = Buffer.alloc(0), from = size;
    for (;;) {
      const end = tail.lastIndexOf(10), start = end > 0 ? tail.lastIndexOf(10, end - 1) : -1;
      if (end >= 0 && (start >= 0 || from === 0)) {
        try { const id = JSON.parse(tail.subarray(start + 1, end).toString("utf8"))?.id; return { id: typeof id === "string" && id ? id : null, size }; }
        catch { return { id: null, size }; }
      }
      if (from === 0 || tail.length > LINE_LIMIT) return { id: null, size };
      const begin = Math.max(0, from - TAIL_CHUNK), chunk = Buffer.alloc(from - begin);
      await handle.read(chunk, 0, chunk.length, begin);
      tail = Buffer.concat([chunk, tail]); from = begin;
    }
  } catch { return none; }
  finally { await handle.close().catch(() => {}); }
}
const identity = model => JSON.stringify([model?.provider, model?.api, model?.baseUrl, model?.id]);
const failure = code => Object.assign(new Error(code), { code, statusCode: 409 });
// Follow only the active branch. An old/abandoned receipt cannot confirm a
// command, even if its nonce happens to occur elsewhere in get_entries.
function receiptOf(data, nonce) {
  if (!Array.isArray(data?.entries) || data.entries.length > 100000) return null;
  const entries = new Map(data.entries.map(entry => [entry.id, entry])), seen = new Set();
  let id = data.leafId;
  while (id && !seen.has(id)) {
    seen.add(id); const entry = entries.get(id); if (!entry) return null;
    if (entry.type === "custom" && entry.customType === COMMAND && entry.data?.nonce === nonce) return entry.data;
    id = entry.parentId;
  }
  return null;
}
function createPiSpeed({ command, write = null, extensionPath = path.join(__dirname, "pi-speed-extension.mjs"),
  catalogExtensionPath = path.join(__dirname, "pi-catalog-extension.mjs") }) {
  const lanes = new Map(), known = new Set(), uncertain = new Set();
  function serial(sid, run) {
    const prior = lanes.get(sid) || Promise.resolve();
    const next = prior.catch(() => {}).then(run); lanes.set(sid, next);
    return next.finally(() => { if (lanes.get(sid) === next) lanes.delete(sid); });
  }
  // Without a cursor Pi knows, the whole list is read only when it is small.
  async function entriesAfter(sid, cursor) {
    if (cursor.id) {
      const after = await command(sid, { type: "get_entries", since: cursor.id });
      if (after?.success) return after;
    }
    return cursor.size <= FULL_ENTRIES_BYTES ? command(sid, { type: "get_entries" }) : null;
  }
  async function handshake(sid, input) {
    if (uncertain.has(sid)) throw failure("speed_reopen_required");
    try { return await handshakeOnce(sid, input); }
    catch (error) {
      if (input.action === "set" && known.has(sid) && !["speed_invalid", "speed_revalidation_required"].includes(error.code)) uncertain.add(sid);
      throw error;
    }
  }
  async function handshakeOnce(sid, input) {
    const commands = await command(sid, { type: "get_commands" });
    if (!commands?.success || !commands.data?.commands?.some(row => row.name === COMMAND && row.source === "extension"
      && typeof row.sourceInfo?.path === "string" && path.resolve(row.sourceInfo.path) === extensionPath)) throw failure("speed_extension_unavailable");
    known.add(sid);
    const before = await command(sid, { type: "get_state" });
    if (!before?.success) throw failure("speed_runtime_unverified");
    // The receipt is appended after everything Pi has now, so read only what
    // follows the last entry: taken before the command, never the receipt.
    const cursor = await lastEntryId(before.data.sessionFile);
    const nonce = crypto.randomUUID();
    const handled = await command(sid, { type: "prompt", message: "/" + COMMAND + " " + JSON.stringify({ ...input, nonce }) });
    if (!handled?.success || handled.data?.disposition !== "handled") throw failure("speed_not_confirmed");
    const entries = await entriesAfter(sid, cursor);
    const receipt = entries?.success ? receiptOf(entries.data, nonce) : null;
    if (!receipt?.ok || receipt.identity !== identity(before.data.model)) throw failure(receipt?.reason || "speed_not_confirmed");
    const after = await command(sid, { type: "get_state" });
    if (!after?.success || identity(after.data.model) !== receipt.identity || before.data.sessionId !== after.data.sessionId) throw failure("speed_revalidation_required");
    if (input.action === "set" && receipt.requested !== input.speed) throw failure("speed_not_confirmed");
    return { ...receipt.capability, requested: receipt.requested, nativeSessionId: after.data.sessionId,
      isStreaming: !!after.data.isStreaming, preferenceFingerprint: receipt.fingerprint, confirmed: "receipt", controlVerified: true };
  }
  async function status(sid) {
    try { return await handshake(sid, { action: "get" }); }
    catch (error) { return { ...unknownSpeed(error.code || "speed_runtime_unverified"), blocked: known.has(sid) || error.code !== "speed_extension_unavailable" }; }
  }
  async function sendUnlocked(sid, cmd, input = {}) {
    // This owned command only reloads local metadata. It starts no model
    // work and must not change the active turn's speed. Other extensions,
    // templates, arguments and attachments still need the normal gate.
    if (cmd?.type === "prompt" && cmd.message === "/stepsemble-refresh-models" && !cmd.images?.length) {
      const commands = await command(sid, { type: "get_commands" });
      const row = commands?.success && commands.data?.commands?.find(row => row.name === "stepsemble-refresh-models");
      if (row?.source === "extension" && typeof row.sourceInfo?.path === "string"
        && path.resolve(row.sourceInfo.path) === catalogExtensionPath) return command(sid, cmd);
    }
    const speed = speedValue(input.speed === undefined ? "standard" : input.speed);
    if (speed === "ultrafast") throw failure("speed_revalidation_required");
    const current = await status(sid);
    if (current.blocked) throw failure("speed_not_confirmed");
    if (speed === "fast" && (current.support !== "supported" || current.fingerprint !== input.speedFingerprint)) throw failure("speed_revalidation_required");
    if (current.support === "supported" || current.requested === "fast") {
      if (current.isStreaming) throw failure("speed_busy");
      await handshake(sid, { action: "set", speed, fingerprint: current.fingerprint });
    }
    if (input.fireAndForget === true && write && current.support !== "supported" && current.requested !== "fast") {
      return { success: write(sid, cmd), data: { disposition: "submitted" } };
    }
    return command(sid, cmd);
  }
  return Object.freeze({
    status: sid => serial(sid, () => status(sid)),
    forget: sid => { known.delete(sid); uncertain.delete(sid); },
    setSpeed: (sid, speed, fingerprint) => serial(sid, () => {
      const requested = speedValue(speed);
      if (requested === "ultrafast") throw failure("speed_revalidation_required");
      return handshake(sid, { action: "set", speed: requested, fingerprint });
    }),
    send: (sid, cmd, input) => serial(sid, () => sendUnlocked(sid, cmd, input)),
    command: (sid, cmd) => ["prompt", "steer", "follow_up", "set_model", "set_thinking_level", "new_session", "switch_session", "fork", "navigate_tree"].includes(cmd?.type)
      ? serial(sid, () => ["prompt", "steer", "follow_up"].includes(cmd.type) ? sendUnlocked(sid, cmd) : command(sid, cmd))
      : command(sid, cmd),
  });
}
module.exports = { createPiSpeed, receiptOf, lastEntryId };
