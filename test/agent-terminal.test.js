"use strict";
// The conversation terminal replays sign-in output onto a screen grid so
// full-screen menus read correctly, then finds the links and codes in it.
const test = require("node:test"), assert = require("node:assert/strict");
const terminal = require("../public/modules/agent-terminal");

test("plain lines, colours and carriage returns land where a terminal puts them", () => {
  const screen = terminal.createScreen({ cols: 40, rows: 6 });
  screen.write("Hello\r\nWorld \x1b[1;31mred\x1b[0m\r\nprogress 10%\rprogress 99%\r\n");
  assert.deepEqual(screen.textRows().slice(0, 3), ["Hello", "World red", "progress 99%"]);
  const red = screen.styledRows()[1].find(run => run.text === "red");
  assert.equal(red.attr.bold, true);
  assert.ok(red.attr.fg);
});

test("menus redrawn with cursor movement show only their latest state", () => {
  const screen = terminal.createScreen({ cols: 50, rows: 10 });
  screen.write("\x1b[?25l│\r\n◆  Select provider\r\n│  ● OpenAI\r\n│  ○ Anthropic\r\n└\r\n");
  screen.write("\x1b[4A\x1b[J◆  Select provider\r\n│  ○ OpenAI\r\n│  ● Anthropic\r\n└\r\n");
  assert.deepEqual(screen.textRows().slice(0, 5), ["│", "◆  Select provider", "│  ○ OpenAI", "│  ● Anthropic", "└"]);
  const full = terminal.createScreen({ cols: 60, rows: 12 });
  full.write("\x1b_Ga=q,f=32;AAAA\x1b\\\x1b[c\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J Welcome to the Antigravity CLI.\r\n > 1. Google OAuth\n\x1b[4G2. Use a Google Cloud project\n\n\x1b[4G\x1b[1m↑/↓\x1b[m Navigate");
  assert.equal(full.alternate, true);
  assert.deepEqual(full.textRows().slice(0, 5), [" Welcome to the Antigravity CLI.", " > 1. Google OAuth", "   2. Use a Google Cloud project", "", "   ↑/↓ Navigate"]);
  full.write("\x1b[?1049l");
  assert.equal(full.alternate, false);
});

test("long sign-in links are joined across wrapped rows and OSC 8 links are kept", () => {
  const screen = terminal.createScreen({ cols: 20, rows: 5 });
  screen.write("go https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bbb end\r\n");
  assert.equal(screen.textRows()[0], "go https://example.c");
  assert.deepEqual(terminal.extractLinks(screen.logicalText()), ["https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bbb"]);
  const osc = terminal.createScreen({ cols: 40, rows: 5 });
  osc.write("visit: \x1b]8;;https://claude.com/cai/oauth/authorize?code=true\x1b\\link\x1b]8;;\x1b\\\r\n");
  assert.deepEqual(osc.links, ["https://claude.com/cai/oauth/authorize?code=true"]);
  assert.deepEqual(terminal.extractLinks("see https://a.example/x). and javascript:alert(1)"), ["https://a.example/x"]);
});

test("one-time codes are found only next to the word code", () => {
  assert.deepEqual(terminal.extractCodes("2. Enter this one-time code (expires in 15 minutes)\r\n   VLG2-J3I1T\r\n"), ["VLG2-J3I1T"]);
  assert.deepEqual(terminal.extractCodes("Released 2026-0925 and ABCD-EFGH with no hint"), []);
  assert.deepEqual(terminal.extractCodes("Your verification code: WDJB-MJHT"), ["WDJB-MJHT"]);
});

test("wide characters take two cells and prompts that ask for secrets are noticed", () => {
  const screen = terminal.createScreen({ cols: 10, rows: 3 });
  screen.write("中文字測試abc");
  assert.deepEqual(screen.textRows().slice(0, 2), ["中文字測試", "abc"]);
  assert.equal(terminal.looksSecretPrompt(["", "Paste the API key: "]), true);
  assert.equal(terminal.looksSecretPrompt(["Select a provider"]), false);
});

test("only the three terminal commands are recognised", () => {
  assert.deepEqual(terminal.parseCommand("/login"), { action: "login", argument: "" });
  assert.deepEqual(terminal.parseCommand("  /LOGOUT openai-codex "), { action: "logout", argument: "openai-codex" });
  assert.equal(terminal.parseCommand("/loginx"), null);
  assert.equal(terminal.parseCommand("please /login"), null);
  assert.equal(terminal.parseCommand("/compact"), null);
});

test("an escape sequence split between writes is still understood", () => {
  const screen = terminal.createScreen({ cols: 20, rows: 3 });
  screen.write("abc\x1b[");
  screen.write("2Kxyz");
  screen.write("\x1b]0;title\x1b");
  screen.write("\\done");
  assert.equal(screen.textRows()[0], "   xyzdone");
});

