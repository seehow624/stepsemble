#!/usr/bin/env node
"use strict";
// Synthetic only: no model, tool, network, account or native session access.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
const lease = path.join(process.cwd(), ".soak-lease");
const boot = crypto.randomUUID();
let sequence = 0;
function alive() {
  try { return Date.now() - fs.statSync(lease).mtimeMs < 120_000; } catch { return false; }
}
if (!alive()) process.exit(70);
const emit = () => process.stdout.write(`TICK:${boot}:${++sequence}\n`);
emit();
readline.createInterface({ input: process.stdin }).on("line", line => {
  if (/^SEND [a-f0-9-]{36}$/.test(line)) { process.stdout.write(`ACK:${line.slice(5)}\n`); emit(); }
});
setInterval(() => { if (!alive()) process.exit(0); }, 1000);
setInterval(emit, 5000);
