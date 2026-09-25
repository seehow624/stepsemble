#!/usr/bin/env node
"use strict";
// Synthetic agent CLI for terminal tests. It never contacts a real service.
const args = process.argv.slice(2).join(" ");
const out = s => process.stdout.write(s);
if (args === "login status" || args === "auth list" || args === "auth status --text" || args === "models") {
  out(process.env.FAKE_SIGNED_IN === "1" ? "Logged in using ChatGPT\n" : "Not logged in\n");
  process.exit(process.env.FAKE_SIGNED_IN === "1" ? 0 : 1);
}
if (args === "login --with-api-key") {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", c => data += c);
  process.stdin.on("end", () => { out(data.trim().startsWith("sk-") ? "Successfully logged in\n" : "Invalid key\n"); process.exit(data.trim().startsWith("sk-") ? 0 : 1); });
  return;
}
if (args.startsWith("login") || args.startsWith("auth login") || args.startsWith("auth add")) {
  out("\x1b[c");
  out("Follow these steps to sign in:\r\n  \x1b[94mhttps://auth.example.test/device\x1b[0m\r\n");
  out("Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\r\n   ABCD-12345\r\n");
  out("Paste code here if prompted > ");
  process.stdin.setEncoding("utf8");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  let line = "";
  process.stdin.on("data", c => { line += c; if (/[\r\n]/.test(line)) { out("\r\nreceived " + line.trim().length + " chars\r\nSuccessfully logged in\r\n"); process.exit(0); } });
  return;
}
if (args === "logout" || args === "auth logout") { out("Successfully logged out\n"); process.exit(0); }
out("unknown: " + args + "\n");
process.exit(2);

