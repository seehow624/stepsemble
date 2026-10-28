#!/usr/bin/env node
"use strict";

// Stepsemble's PreToolUse hook for Google Antigravity (agy). agy runs it
// before each tool call of a conversation Stepsemble started, with the call
// on stdin, and does what it prints: {"decision":"allow"} or "deny". It asks
// the Host's approval gate (server/antigravity-gate.js) over a local socket,
// with the token the Host gave this agy process.
//
// agy runs with --dangerously-skip-permissions, so this hook is the only
// gate. agy treats a hook that exits non-zero, prints something other than
// JSON or times out as a denial, but a hook that exits 0 without printing
// lets the call through. So this hook always prints a decision, denies on
// any doubt, and exits non-zero whenever it could not print one.

const net = require("node:net");

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
let answered = false;

function answer(decision, reason) {
  if (answered) return;
  answered = true;
  const value = JSON.stringify({ decision: decision === "allow" ? "allow" : "deny", reason: String(reason || "").slice(0, 2000) });
  try {
    process.stdout.write(value + "\n", error => process.exit(error ? 2 : 0));
  } catch { process.exit(2); }
}

process.on("uncaughtException", error => answer("deny", "Stepsemble's approval hook failed: " + String(error?.message || error).slice(0, 200)));
process.on("unhandledRejection", error => answer("deny", "Stepsemble's approval hook failed: " + String(error?.message || error).slice(0, 200)));

const socketPath = process.env.STEPSEMBLE_AGY_GATE || "";
const token = process.env.STEPSEMBLE_AGY_GATE_TOKEN || "";
const chunks = [];
let size = 0;
process.stdin.on("data", chunk => {
  size += chunk.length;
  if (size > MAX_INPUT_BYTES) { answer("deny", "The tool call was too large to check."); return; }
  chunks.push(chunk);
});
process.stdin.on("error", () => answer("deny", "The tool call could not be read."));
process.stdin.on("end", () => {
  if (answered) return;
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { answer("deny", "The tool call could not be read."); return; }
  if (!socketPath || !/^[a-f0-9]{64}$/.test(token)) { answer("deny", "This Antigravity process was not started by Stepsemble."); return; }
  const socket = net.connect(socketPath);
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("connect", () => { socket.write(JSON.stringify({ token, payload }) + "\n"); });
  socket.on("data", text => {
    buffer += text;
    const end = buffer.indexOf("\n");
    if (end < 0) { if (buffer.length > 64 * 1024) answer("deny", "Stepsemble's answer could not be read."); return; }
    let decision;
    try { decision = JSON.parse(buffer.slice(0, end)); } catch { answer("deny", "Stepsemble's answer could not be read."); return; }
    answer(decision?.decision === "allow" ? "allow" : "deny", typeof decision?.reason === "string" ? decision.reason : "");
    socket.destroy();
  });
  socket.on("error", () => answer("deny", "Stepsemble could not be reached to approve this action."));
  socket.on("close", () => answer("deny", "Stepsemble closed the approval without an answer."));
});
