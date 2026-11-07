"use strict";

// ⌘, opens Settings, as in other Mac apps: the app's own Stepsemble menu has
// Settings… under About, and the Workspace and its conversations answer the
// same keys (Ctrl+, elsewhere). The browser cases open them; these hold the
// app's part, which CI builds but does not drive.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8").replace(/\r\n/g, "\n");
const swift = read("macos/Stepsemble/main.swift"), workspace = read("public/modules/workspace.js"), app = read("public/app.js");
const between = (source, from, to) => { const start = source.indexOf(from), end = source.indexOf(to, start); assert.ok(start >= 0 && end > start, from); return source.slice(start, end); };

test("the app's Stepsemble menu has Settings… with ⌘, under About, in every language", () => {
  assert.match(swift, /item\(Text\.t\("about"\), #selector\(NSApplication\.orderFrontStandardAboutPanel\(_:\)\), target: NSApp\), \.separator\(\),\n\s+item\(Text\.t\("settings"\), #selector\(openSettings\(_:\)\), ",", target: self\), \.separator\(\)\]/);
  const titles = [...swift.matchAll(/^ {12}"settings": "([^"]+)",$/gm)].map(match => match[1]);
  assert.equal(titles.length, 11, "English and the ten translations");
  // An item that opens a window ends in an ellipsis (German sets it apart, as Apple's menus do).
  for (const title of titles) assert.match(title, /^\S.*[…⋯]$/, title);
});

test("Settings… open over the front Workspace window, or in a new one, once its Workspace has loaded", () => {
  const choose = between(swift, "    @objc func openSettings(_ sender: Any?) {", "    @objc func showFolderAccess(");
  assert.match(choose, /\$0\.window === NSApp\.keyWindow/, "the front window first");
  assert.match(choose, /\?\? newWindow\(path: "\/workspace\.html"\)\)\.openSettings\(\)/, "with no window left, a new one");
  const open = between(swift, "    func openSettings() {", "    func openNotice(");
  assert.match(open, /pendingSettings = true\n\s+if !webView\.isLoading \{ sendPendingSettings\(\) \}/);
  assert.match(open, /guard pendingSettings, let url = webView\.url, isHost\(url\), url\.path == "\/workspace\.html" else \{ return \}/, "only the Host's Workspace is asked");
  assert.match(open, /evaluateJavaScript\("window\.dispatchEvent\(new Event\('stepsemble-open-settings'\)\)"/);
  assert.match(between(swift, "    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {", "    func webViewWebContentProcessDidTerminate("),
    /sendPendingSettings\(\)/, "a window waiting for its Host, or for signing in, opens them when the Workspace loads");
});

test("⌘, or Ctrl+, are the keys, not with Shift, Option or while composing", () => {
  const keys = new Function("return " + workspace.match(/const settingsKeys = (event => [^\n]+);\n/)[1])();
  const press = extra => keys({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, key: ",", ...extra });
  assert.equal(press({ metaKey: true }), true); assert.equal(press({ ctrlKey: true }), true);
  for (const other of [{}, { metaKey: true, shiftKey: true }, { metaKey: true, altKey: true }, { ctrlKey: true, isComposing: true }, { metaKey: true, key: "." }]) {
    assert.equal(press(other), false, JSON.stringify(other));
  }
  // A conversation asks its Workspace, which listens only to its own panes; Settings and the sign-in page keep the keys.
  assert.match(app, /event\.preventDefault\(\);\n\s+if \(WORKSPACE_PANE && PAGE_EMBEDDED\) parent\.postMessage\(\{ type: "workspace-open-settings" \}, location\.origin\);\n\s+return;/);
  assert.match(read("public/modules/schedules-page.js"), /event\.key === ","\) \{\n\s+event\.preventDefault\(\); tell\(\{ type: "workspace-open-settings" \}\); return;/, "and so does a Schedules tab");
  const message = between(workspace, '  window.addEventListener("message", event => {\n    if (event.origin !== location.origin) return;', "  const usageUI =");
  assert.ok(message.indexOf("if (!item) return;") < message.indexOf('"workspace-open-settings") openSettingsSoon();'), "only from a pane it holds");
  const soon = between(workspace, "  function openSettingsSoon() {", "  addEventListener(\"stepsemble-open-settings\"");
  assert.match(soon, /if \(!booted\) \{ pendingSettings = true; return; \}/);
  assert.match(soon, /if \(settingsLayer \|\| \$\("workspace-dialog"\)\.open\) return;/, "a dialog in front keeps the keys");
});
