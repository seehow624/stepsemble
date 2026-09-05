"use strict";

// Legacy Pi RPC wire boundary, separate from the reserved Stepsemble v1 schema.
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/.test(value);
const commandName = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,127}(?![\s\S])/.test(value);
function protocolError(message = "Invalid native RPC frame") { const error = new Error(message); error.statusCode = 502; return error; }
function parsePiEvent(line) {
  let event;
  try { event = JSON.parse(line); } catch { throw protocolError(); }
  if (!record(event) || !commandName(event.type)) throw protocolError();
  if (event.type === "response") {
    if (!commandName(event.command) || typeof event.success !== "boolean" || event.id !== undefined && !identifier(event.id)) throw protocolError();
    if (!event.success && typeof event.error !== "string") throw protocolError();
    if (event.success && event.command === "get_state" && (!record(event.data) || typeof event.data.isStreaming !== "boolean")) throw protocolError();
  }
  return event;
}
function validPiCommand(command) {
  // UI responses have no correlated native ACK and must use the dedicated,
  // strictly typed endpoint. This also prevents bypassing its boolean checks.
  return record(command) && commandName(command.type) && command.type !== "extension_ui_response";
}
function resolvePiResponse(pending, sid, event) {
  if (event.type !== "response" || !event.id) return false;
  const request = pending.get(event.id);
  // Native output from one process may not settle another process's request.
  if (!request || request.sid !== sid) return false;
  pending.delete(event.id);
  if (event.command !== request.command) request.reject(protocolError("Native RPC response does not match its command"));
  else request.resolve(event);
  return true;
}
function parsePiUiReply(body) {
  const fail = () => { const error = new Error("Invalid native UI reply"); error.statusCode = 400; throw error; };
  if (!record(body) || !identifier(body.sid) || !identifier(body.id)) return fail();
  const fields = ["value", "confirmed", "cancelled"].filter(key => Object.hasOwn(body, key));
  if (fields.length !== 1) return fail();
  const key = fields[0], value = body[key];
  if (key === "confirmed" && typeof value !== "boolean" || key === "cancelled" && value !== true
    || key === "value" && (typeof value !== "string" || Buffer.byteLength(value) > 1024 * 1024)) return fail();
  return { type: "extension_ui_response", id: body.id, [key]: value };
}

module.exports = { parsePiEvent, validPiCommand, resolvePiResponse, parsePiUiReply };
