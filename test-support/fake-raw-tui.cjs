#!/usr/bin/env node
"use strict";

// A stand-in for a full-screen terminal program such as agy, Codex or Claude
// Code. Like them it reads keys in raw mode: Enter is a carriage return and
// submits; a line feed only adds a line to the input box. It reports what it
// understood on its own lines, so a test can tell a submitted message from
// one left waiting in the box.
//   FAKE_TUI_PASTE=0        do not turn bracketed paste on
//   FAKE_TUI_MENU=a,b,c     start on a menu chosen with arrows and Enter
//   FAKE_TUI_CHOSE_FILE     when the menu is answered, write FAKE_TUI_CHOSE_JSON
//                           there, the way agy records its first-run pages

const say = text => process.stdout.write(text + "\r\n");
if (!process.stdin.isTTY) { say("NOT_A_TTY"); process.exit(3); }
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
const paste = process.env.FAKE_TUI_PASTE !== "0";
if (paste) process.stdout.write("\x1b[?2004h");
let menu = String(process.env.FAKE_TUI_MENU || "").split(",").filter(Boolean);
let selected = 0;
say("READY raw paste=" + (paste ? "on" : "off"));
if (menu.length) say("MENU:" + menu[selected]);

let box = "", pasting = null;
const ARROWS = { A: "up", B: "down", C: "right", D: "left" };

function key(name) {
  if (menu.length && (name === "up" || name === "down")) {
    selected = (selected + (name === "down" ? 1 : menu.length - 1)) % menu.length;
    say("MENU:" + menu[selected]);
    return;
  }
  say("KEY:" + name);
}

function enter() {
  if (menu.length) {
    say("CHOSE:" + menu[selected]);
    menu = [];
    const file = process.env.FAKE_TUI_CHOSE_FILE;
    if (file) {
      require("node:fs").mkdirSync(require("node:path").dirname(file), { recursive: true });
      require("node:fs").writeFileSync(file, process.env.FAKE_TUI_CHOSE_JSON || "{}");
    }
    return;
  }
  say("SUBMIT:" + JSON.stringify(box));
  box = "";
}

process.stdin.on("data", data => {
  let text = String(data);
  while (text.length) {
    if (pasting !== null) {
      const end = text.indexOf("\x1b[201~");
      if (end < 0) { pasting += text; return; }
      pasting += text.slice(0, end);
      box += pasting;
      say("PASTE:" + JSON.stringify(pasting));
      pasting = null;
      text = text.slice(end + 6);
      continue;
    }
    if (text.startsWith("\x1b[200~")) { pasting = ""; text = text.slice(6); continue; }
    const arrow = /^\x1b\[([ABCD])/.exec(text);
    if (arrow) { key(ARROWS[arrow[1]]); text = text.slice(3); continue; }
    const ch = text[0];
    text = text.slice(1);
    if (ch === "\x1b") key("escape");
    else if (ch === "\r") enter();
    else if (ch === "\n") { box += "\n"; say("NEWLINE"); }
    else if (ch === "\x7f") { box = box.slice(0, -1); say("KEY:backspace"); }
    else if (ch === "\t") key("tab");
    else if (ch === "\x03") key("ctrl-c");
    else if (ch === "\x04") key("ctrl-d");
    else if (ch === " " && menu.length) key("space");
    else if (ch >= " ") box += ch;
    else say("CONTROL:" + ch.charCodeAt(0));
  }
});
setInterval(() => {}, 1000);
