"use strict";
// The conversation terminal replays sign-in output onto a screen grid so
// full-screen menus read correctly, then finds the links and codes in it.
const test = require("node:test"), assert = require("node:assert/strict");
const terminal = require("../public/modules/agent-terminal");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");

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

test("OAuth targets keep their parameters when a terminal prints a shortened link label", () => {
  const target = "https://accounts.google.com/o/oauth2/auth?client_id=synthetic&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A9876%2Fcallback&state=synthetic";
  const label = "https://accounts.google.com/o/oauth2/auth";
  const other = "https://docs.example.test/sign-in";
  const output = "\x1b]8;;" + target + "\x1b\\" + label + "\x1b]8;;\x1b\\\r\n" + other;
  assert.deepEqual(terminal.extractLinks(output, [target]), [target, other]);
  // Explicit targets are separate links even when one prefixes another.
  assert.deepEqual(terminal.extractLinks("", [label, target]), [label, target]);
});

test("the conversation login buttons use the redrawn screen and preserve complete OAuth URLs", () => {
  const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const writeFunction = app.slice(app.indexOf("function agentTerminalWrite("), app.indexOf("function agentTerminalLine("));
  const context = vm.createContext({ agentTerminalApi: terminal, scheduleAgentTerminalRender() {} });
  vm.runInContext(writeFunction, context);
  const target = "https://accounts.google.com/o/oauth2/auth?client_id=synthetic&code_challenge=synthetic&response_type=code&scope=openid%20email&state=synthetic";
  for (const cols of [40, 100]) {
    const term = { screen: terminal.createScreen({ cols, rows: 24 }), raw: "", mode: "pty", action: "login" };
    // Antigravity's hyperlink target arrives first; its displayed label then
    // wraps and is redrawn. The old raw-output parser kept the short label as
    // the newest link, which the UI promoted to its primary Open button.
    const output = "\x1b]8;;" + target + "\x1b\\https://accounts.google.com/o/oauth2/auth\x1b]8;;\x1b\\\r\n";
    for (const chunk of [output.slice(0, 25), output.slice(25, 92), output.slice(92)]) context.agentTerminalWrite(term, chunk);
    assert.deepEqual(term.links, [target]);
    const primary = new URL(term.links.at(-1));
    assert.equal(primary.searchParams.get("response_type"), "code");
    assert.equal(primary.searchParams.get("state"), "synthetic");
    context.agentTerminalWrite(term, "\x1b[2J\x1b[Hhttps://auth.example.test/device\r\n");
    assert.equal(term.links.at(-1), "https://auth.example.test/device");
  }
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

test("a full-screen page in a taller terminal shows through its last line, without the blank rows below", () => {
  // A first-run page like Antigravity's Terms: text, then its buttons last.
  const screen = terminal.createScreen({ cols: 49, rows: 40 });
  const page = ["Terms of Service & Data Use", ""];
  for (let i = 0; i < 26; i++) page.push("line " + i);
  page.push("", "    [Previous]      [Done]", "", "  \u2191/\u2193 Navigate \u00b7 enter Confirm");
  screen.write("\x1b[?1049h\x1b[?25l\x1b[H" + page.join("\r\n") + "\x1b[40;1H");
  const shown = screen.styledRows().map(runs => runs.map(run => run.text).join("").trimEnd());
  assert.equal(shown.length, page.length);
  assert.equal(shown.at(-3), "    [Previous]      [Done]");
  // A visible cursor below the page keeps the rows down to where typing appears.
  screen.write("\x1b[?25h\x1b[36;1H");
  assert.equal(screen.styledRows().length, 36);
});
