"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

function section(startMarker, endMarker) {
  const start = server.indexOf(startMarker);
  const end = server.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${startMarker} section exists`);
  return server.slice(start, end);
}

test("native mutation routes are allow-listed and reserved before the first body await", () => {
  const declaration = server.split("\n").find(line => line.includes("const NATIVE_WORK_ROUTE"));
  assert.ok(declaration);
  const literal = declaration.slice(declaration.indexOf("=") + 1, declaration.lastIndexOf(";")).trim();
  const route = vm.runInNewContext(literal);
  for (const pathname of [
    "/api/open", "/api/send", "/api/agent/open", "/api/codex/mutation/resume",
    "/api/opencode/message", "/api/grok/acp/prompt", "/api/claude/structured/prompt",
    "/api/antigravity/structured/permission",
  ]) assert.equal(route.test(pathname), true, pathname);
  for (const pathname of ["/api/harness-updates/apply", "/api/harness-updates/apply-all", "/api/codex/mutation", "/api/session-search"])
    assert.equal(route.test(pathname), false, pathname);

  const auth = server.indexOf('if (p.startsWith("/api/"))');
  const reservation = section('if (req.method === "POST" && NATIVE_WORK_ROUTE.test(p))', 'if (p === "/api/protocol/handshake"');
  assert.ok(auth < server.indexOf('if (req.method === "POST" && NATIVE_WORK_ROUTE.test(p))'),
    "route reservation is behind the normal authentication gate");
  assert.match(reservation, /nativeWorkRequests\+\+/);
  assert.match(reservation, /res\.once\("finish", release\)/);
  assert.match(reservation, /res\.once\("close", release\)/);
  const reservationOffset = server.indexOf('if (req.method === "POST" && NATIVE_WORK_ROUTE.test(p))');
  assert.ok(server.indexOf("nativeWorkRequests++", reservationOffset) < server.indexOf("await readJSON(", reservationOffset),
    "the reservation is held while request JSON is being parsed and dispatched");
});

test("the asynchronous update guard observes native request reservations", () => {
  const active = section("function activeAgentTasksForUpdate()", "// The inbox uses one task shape");
  assert.match(active, /nativeWorkRequests\s*>\s*0/);
  const service = section("beforeUpdate: async", "busy: () =>");
  assert.match(service, /activeAgentTasksForUpdate\(\)\.length/);
  assert.match(server, /if \(harnessUpdateService\?\.isRunning\(\)\) \{ sendJSON\(res, 409, \{ error: "harness_update_in_progress" \}\); return; \}/);
});
