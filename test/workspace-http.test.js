"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs/promises");
const { spawn } = require("node:child_process"), { once } = require("node:events");
test("workspace HTTP isolates membership, history, project registration and pane framing", async t => {
  const child = spawn(process.execPath, [path.resolve(__dirname, "../scripts/workspace-preview.mjs")], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, "close"); child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000); await done; clearTimeout(timer);
    }
  });
  const fixture = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("workspace fixture startup timed out")), 45000);
    child.once("exit", () => { clearTimeout(timer); reject(new Error("workspace fixture exited")); });
    child.stdout.on("data", chunk => {
      output += chunk;
      if (!output.includes("\n")) return;
      try { const value = JSON.parse(output.split("\n")[0]); clearTimeout(timer); resolve(value); } catch {}
    });
    child.stderr.resume();
  });
  const { url, token, home } = fixture;
  let cookie = "";
  const request = (route, body, origin = url) => fetch(url + route, {
    headers: { Cookie: cookie, Origin: origin, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.equal((await request("/api/workspace")).status, 401);
  const login = await request("/api/login", { token }); assert.equal(login.status, 204);
  cookie = login.headers.get("set-cookie").split(";")[0];
  const before = await (await request("/api/workspace")).json();
  assert.equal(before.entries.length, 2);
  assert.ok(!JSON.stringify(before).includes("outputTail"));
  const taskFile = path.join(home, ".config/stepsemble/agent-tasks.json");
  const tasksBefore = await fs.readFile(taskFile, "utf8");
  assert.equal((await request("/api/workspace/project", { cwd: home })).status, 200);
  assert.equal((await (await request("/api/workspace")).json()).entries.length, 2);
  assert.equal((await request("/api/workspace/adopt", { kind: "arbitrary", reference: "x" })).status, 400);
  const sessions = await (await request("/api/sessions?includeTemporary=1")).json();
  const external = sessions.sessions.find(row => row.file.endsWith("external.jsonl")); assert.ok(external);
  const preview = await (await request(`/api/session?file=${encodeURIComponent(external.file)}`)).json();
  assert.match(preview.messages[0].text, /External history/);
  assert.equal((await (await request("/api/workspace")).json()).entries.length, 2);
  assert.equal((await request("/api/workspace/adopt", { kind: "pi_history", reference: external.file }, "https://evil.invalid")).status, 403);
  const adopted = await (await request("/api/workspace/adopt", { kind: "pi_history", reference: external.file })).json();
  assert.equal(adopted.origin, "added");
  const again = await (await request("/api/workspace/adopt", { kind: "pi_history", reference: external.file })).json();
  assert.equal(again.key, adopted.key);
  assert.equal((await (await request(`/api/workspace/entry?key=${adopted.key}`)).json()).record.file, external.file);
  assert.equal((await request("/api/workspace/remove", { key: adopted.key })).status, 200);
  assert.equal((await request(`/api/workspace/entry?key=${adopted.key}`)).status, 404);
  assert.equal(await fs.readFile(taskFile, "utf8"), tasksBefore, "project/history/view operations never launch or stop a task");
  assert.ok(await fs.stat(path.join(home, ".pi/agent/sessions", external.file)));
  assert.match(await (await request("/")).text(), /workspace-stage/);
  assert.equal((await request("/index.html")).headers.get("x-frame-options"), "DENY");
  const pane = await request("/index.html?pane=1");
  assert.equal(pane.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(pane.headers.get("content-security-policy"), /frame-ancestors 'self'/);
});
