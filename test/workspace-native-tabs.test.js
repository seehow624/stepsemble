"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const swift = fs.readFileSync("macos/Stepsemble/main.swift", "utf8");
test("native workspace popup closes its tab before considering generic popup close", () => {
  const body = swift.slice(swift.indexOf("    func closeSessionTab("), swift.indexOf("    private static let zoomSteps"));
  assert.ok(body.indexOf('url.path == "/workspace.html"') < body.indexOf("if isPopup"));
});
test("native tab tracking has owned threshold, explicit mouseUp, Escape and bounded teardown", () => {
  assert.match(swift, /final class WorkspaceTabDragArea/);
  assert.match(swift, /case \.leftMouseUp:/);
  assert.match(swift, /event\.keyCode == 53/);
  assert.match(swift, /Date\(\) < deadline/);
  assert.match(swift, /hypot\(/);
  assert.match(swift, /tab-drag-regions/);
  assert.match(swift, /\.command, \.option/);
  assert.match(swift, /window\.makeKey\(\)/, "a deliberately clicked tab activates its own window");
});
test("native tear-out uses owned windows and explicit release, not desktop identity", () => {
  assert.match(swift, /workspaceWindow\(at: screen\)/);
  assert.match(swift, /destinationWindow == nil && NSScreen\.screens\.contains/);
  assert.match(swift, /NSApp\.orderedWindows where candidate\.isVisible && !candidate\.isMiniaturized/);
  assert.doesNotMatch(swift, /isDesktopDrop|CGWindowListCopyWindowInfo|windowNumber\(at:/);
});
