"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs/promises"), http = require("node:http"), zlib = require("node:zlib");
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
  // fetch() decodes content codings for the caller, so byte-exact delivery is
  // read through http.get, which hands back what actually crossed the wire.
  const wire = (route, headers = {}) => new Promise((resolve, reject) => {
    const target = new URL(url + route);
    const req = http.get({ hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`,
      headers: { Cookie: cookie, ...headers } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
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
  const untitled = sessions.sessions.find(row => row.file.endsWith("untitled.jsonl")); assert.ok(untitled);
  const plain = await (await request("/api/workspace/adopt", { kind: "pi_history", reference: untitled.file })).json();
  assert.equal(plain.record.name, undefined);
  assert.equal((await (await request("/api/workspace")).json()).entries.find(row => row.key === plain.key).record.name, "Plan the dashboard layout");
  const registry = await fs.readFile(path.join(home, ".config/stepsemble/workspaces.json"), "utf8");
  assert.ok(!registry.includes("Plan the dashboard layout"), "first-message text stays out of workspace membership storage");
  assert.equal((await (await request(`/api/session?file=${encodeURIComponent(untitled.file)}`)).json()).firstMessage, "Plan the dashboard layout");
  assert.equal((await (await request("/api/workspace")).json()).entries.find(row => row.key === plain.key).record.name, "Plan the dashboard layout");
  assert.equal((await request("/api/rename", { file: untitled.file, name: "Dashboard plan" })).status, 200);
  assert.equal((await (await request(`/api/workspace/entry?key=${plain.key}`)).json()).record.name, "Dashboard plan");

  // Any session can be renamed. The Host keeps the name over the agent's own,
  // and a Pi session's own name follows.
  const typed = before.entries.find(row => row.record.name === "API 開發"); assert.ok(typed);
  assert.equal((await request("/api/workspace/rename", { key: typed.key, name: "API 設計" }, "https://evil.invalid")).status, 403);
  assert.equal((await request("/api/workspace/rename", { key: typed.key, name: "   " })).status, 400);
  assert.equal((await request("/api/workspace/rename", { key: "00000000-0000-0000-0000-000000000000", name: "x" })).status, 404);
  assert.deepEqual(await (await request("/api/workspace/rename", { key: typed.key, name: "Not a chosen name", auto: true })).json(),
    { renamed: false, name: "API 開發" }, "a typed name is never replaced by a first message");
  assert.equal((await (await request("/api/workspace/rename", { key: typed.key, name: "  API\n設計 " })).json()).name, "API 設計");
  // The task list still names it API 開發; the chosen name stays.
  assert.equal((await (await request("/api/workspace")).json()).entries.find(row => row.key === typed.key).record.name, "API 設計");
  assert.equal((await (await request(`/api/workspace/entry?key=${typed.key}`)).json()).record.name, "API 設計");
  assert.equal((await (await request("/api/workspace/rename", { key: plain.key, name: "First", auto: true })).json()).renamed, false, "Pi names itself");
  assert.equal((await (await request("/api/workspace/rename", { key: plain.key, name: "Dashboard layout" })).json()).name, "Dashboard layout");
  assert.equal((await (await request(`/api/session?file=${encodeURIComponent(untitled.file)}`)).json()).name, "Dashboard layout");
  assert.equal((await (await request("/api/workspace")).json()).entries.find(row => row.key === plain.key).record.name, "Dashboard layout");
  // A session nobody named takes its first message as its name, once; a
  // command does not name it.
  const unnamed = await (await request("/api/workspace/adopt", { kind: "task_record", reference: "workspace-fixture-3" })).json();
  assert.equal(unnamed.record.name, "Claude Code 1a2b3c4d");
  assert.equal((await request("/api/workspace/rename", { key: unnamed.key, name: "/model sonnet", auto: true })).status, 400);
  const first = await (await request("/api/workspace/rename", { key: unnamed.key, name: "你現在是什麼模型呢\n請說明", auto: true })).json();
  assert.deepEqual([first.renamed, first.name], [true, "你現在是什麼模型呢"]);
  assert.equal((await (await request("/api/workspace/rename", { key: unnamed.key, name: "Second message", auto: true })).json()).renamed, false);
  assert.equal((await (await request("/api/workspace")).json()).entries.find(row => row.key === unnamed.key).record.name, "你現在是什麼模型呢");
  assert.equal((await request("/api/workspace/remove", { key: unnamed.key })).status, 200);

  const project = path.join(home, "Projects", "Demo");
  assert.equal((await request("/api/workspace/project/remove", { cwd: "relative" })).status, 400);
  const removedProject = await request("/api/workspace/project/remove", { cwd: project });
  assert.equal(removedProject.status, 200);
  assert.equal((await removedProject.json()).keys.length, 3);
  assert.equal((await (await request("/api/workspace")).json()).entries.length, 0);
  assert.equal((await request("/api/workspace/project/remove", { cwd: project })).status, 404);
  assert.equal(await fs.readFile(taskFile, "utf8"), tasksBefore, "project/history/view operations never launch or stop a task");
  assert.ok(await fs.stat(path.join(home, ".pi/agent/sessions", external.file)));
  assert.match(await (await request("/")).text(), /workspace-stage/);
  assert.equal((await request("/index.html")).headers.get("x-frame-options"), "DENY");
  const pane = await request("/index.html?pane=1");
  assert.equal(pane.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(pane.headers.get("content-security-policy"), /frame-ancestors 'self'/);

  // A phone pays for every uncompressed byte of the client bundle, so the
  // assets are served compressed, kept for the release's own URL, and never
  // answered across encodings with one shared validator.
  const plainAsset = await wire("/app.js?v=3.1.3", { "Accept-Encoding": "identity" });
  const brotliAsset = await wire("/app.js?v=3.1.3", { "Accept-Encoding": "br" });
  const gzipAsset = await wire("/app.js?v=3.1.3", { "Accept-Encoding": "gzip" });
  assert.equal(plainAsset.status, 200);
  assert.equal(plainAsset.headers["content-encoding"], undefined);
  assert.equal(brotliAsset.headers["content-encoding"], "br");
  assert.equal(gzipAsset.headers["content-encoding"], "gzip");
  assert.ok(brotliAsset.bytes.length < plainAsset.bytes.length / 2, "brotli must halve the bundle or better");
  assert.equal(zlib.brotliDecompressSync(brotliAsset.bytes).length, plainAsset.bytes.length);
  assert.equal(zlib.gunzipSync(gzipAsset.bytes).length, plainAsset.bytes.length);
  assert.match(brotliAsset.headers["cache-control"], /immutable/, "a versioned asset is content-addressed by its release");
  assert.match(brotliAsset.headers.vary, /accept-encoding/i);
  assert.notEqual(brotliAsset.headers.etag, plainAsset.headers.etag, "each representation needs its own validator");
  assert.equal((await wire("/app.js?v=3.1.3", { "Accept-Encoding": "br", "If-None-Match": brotliAsset.headers.etag })).status, 304);
  assert.equal((await wire("/app.js?v=3.1.3", { "If-None-Match": brotliAsset.headers.etag })).status, 200, "a validator must not answer for another encoding");
  assert.match((await wire("/modules/workspace.js", { "Accept-Encoding": "br" })).headers["cache-control"], /max-age=86400/, "an unversioned asset keeps the short cache");
  // The fixture ships one transcript above the threshold; fixture paths alone
  // are too short on Linux to make a response compressible.
  const transcript = `/api/session?file=${encodeURIComponent("demo/padding.jsonl")}&limit=300`;
  const plainJSON = await wire(transcript, { "Accept-Encoding": "identity" });
  const gzipJSON = await wire(transcript, { "Accept-Encoding": "gzip" });
  assert.equal(plainJSON.status, 200);
  assert.ok(plainJSON.bytes.length >= 1024, "the padded transcript must exceed the compression threshold");
  assert.equal(gzipJSON.headers["content-encoding"], "gzip");
  assert.ok(gzipJSON.bytes.length < plainJSON.bytes.length);
  assert.deepEqual(JSON.parse(zlib.gunzipSync(gzipJSON.bytes)), JSON.parse(plainJSON.bytes));
  assert.equal((await wire("/api/workspace", { "Accept-Encoding": "gzip" })).headers["content-encoding"], undefined, "small responses stay uncompressed");
});
