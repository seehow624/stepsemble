"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { createFakeHermesGateway } = require("../test-support/fake-hermes-gateway.cjs");
const { isolatedEnvironment } = require("../test-support/env");

const root = path.resolve(__dirname, "..");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n% synthetic test document\n%%EOF\n");

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function host(t, fake) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-assistant-media-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "hermes"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "hermes.cmd"), "@echo off\r\nexit /b 0\r\n");
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    env: isolatedEnvironment({ HOME: home, PI_HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STEPSEMBLE_HOST: "127.0.0.1",
      STEPSEMBLE_PORT: String(port), PI_BIN: "/path/that/does/not/exist", STEPSEMBLE_HERMES_URL: fake.url, STEPSEMBLE_HERMES_ACP: "0" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10_000))]);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 20_000);
    const read = chunk => { output += chunk; if (output.includes(" listening on ")) { clearTimeout(timer); resolve(); } };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("exit", code => reject(new Error(`server exited ${code}:\n${output}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const token = fs.readFileSync(path.join(home, ".config", "stepsemble", "token"), "utf8").trim();
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  const headers = { cookie: (login.headers.get("set-cookie") || "").split(";", 1)[0], "content-type": "application/json" };
  const call = async (pathname, body) => {
    const response = await fetch(base + pathname, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const media = (file, extra = "", init = {}) => fetch(`${base}/api/assistant/media?path=${encodeURIComponent(file)}${extra}`, { ...init, headers: { ...headers, ...init.headers } });
  return { base, headers, call, media };
}

async function reply(call, chat) {
  assert.equal((await call("/api/assistant/prompt", { sessionId: chat.sessionId, text: "給我檔案" })).status, 202);
  for (let tries = 0; tries < 100; tries += 1) {
    const view = (await call("/api/assistant/session/open", { sessionId: chat.sessionId, profile: "default" })).body;
    if (view.messages?.some(message => message.role === "assistant")) return view;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Bot 沒有回覆");
}

test("Bot 傳來的附件只能經 Hermes 檔案介面取得，且需要先在對話中出現", async t => {
  const fake = createFakeHermesGateway({ authRequired: false });
  await fake.start();
  t.after(() => fake.close());
  fake.addFile("/fake/media/report.pdf", PDF);
  fake.addFile("/fake/media/photo.png", PNG);
  fake.addFile("/fake/media/page.html", Buffer.from("<script>alert(1)</script>"));
  fake.addFile("/fake/media/clip.mp4", Buffer.from("0123456789"));
  fake.addFile("/fake/media/config.yaml", Buffer.from("secret: no"));
  fake.addFile("/fake/media/never-sent.png", PNG);
  const { call, media } = await host(t, fake);
  const chat = (await call("/api/assistant/bot-chat", { profile: "default" })).body;
  assert.equal(fake.state.sources.at(-1), "desktop", "Stepsemble 以圖形介面開對話，Bot 才會用附件格式");
  assert.equal((await media("/fake/media/report.pdf")).status, 404, "尚未出現在對話中的路徑不能讀取");
  fake.setTurn({ reply: "報告好了 MEDIA:/fake/media/report.pdf\n**MEDIA:/fake/media/photo.png**\nMEDIA:/fake/media/page.html MEDIA:/fake/media/clip.mp4\nMEDIA:/fake/media/config.yaml" });
  await reply(call, chat);
  assert.ok(fake.state.sources.filter(source => source === "desktop").length >= 2, "重開對話也維持圖形介面");

  const pdf = await media("/fake/media/report.pdf");
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.match(pdf.headers.get("content-disposition"), /^inline;.*filename\*=UTF-8''report\.pdf/);
  assert.equal(pdf.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), PDF);
  assert.match((await media("/fake/media/report.pdf", "&download=1")).headers.get("content-disposition"), /^attachment;/);

  const image = await media("/fake/media/photo.png");
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.match(image.headers.get("content-security-policy"), /sandbox/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);

  const page = await media("/fake/media/page.html");
  assert.equal(page.headers.get("content-type"), "application/octet-stream", "網頁檔只下載，不在 Stepsemble 網域內執行");
  assert.match(page.headers.get("content-disposition"), /^attachment;/);

  const clip = await media("/fake/media/clip.mp4", "", { headers: { range: "bytes=2-5" } });
  assert.equal(clip.status, 206);
  assert.equal(clip.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(Buffer.from(await clip.arrayBuffer()).toString(), "2345");

  const secret = await media("/fake/media/config.yaml");
  assert.equal(secret.status, 403, "Hermes 擋下的敏感檔案維持拒絕");
  assert.equal((await secret.json()).error, "assistant_media_forbidden");
  assert.equal((await media("/fake/media/never-sent.png")).status, 404);
  assert.equal(fake.state.downloads.some(item => item.path === "/fake/media/never-sent.png"), false);
  assert.equal(fake.state.prompts.length, 1);
});

test("重新載入歷史對話時，舊訊息裡的附件仍可開啟", async t => {
  const fake = createFakeHermesGateway({ authRequired: false });
  await fake.start();
  t.after(() => fake.close());
  fake.addFile("/fake/media/old.pdf", PDF);
  const stored = fake.addSession("default", "舊報告", { source: "telegram" });
  stored.messages.push({ role: "user", text: "上週的報告" }, { role: "assistant", text: "在這裡 MEDIA:/fake/media/old.pdf" }, { role: "user", text: "MEDIA:/fake/media/old-user.pdf" });
  fake.addFile("/fake/media/old-user.pdf", PDF);
  const { call, media } = await host(t, fake);
  await call("/api/assistant/session/open", { sessionId: stored.id, profile: "default" });
  assert.equal(fake.state.sources.at(-1), "desktop");
  assert.equal((await media("/fake/media/old.pdf")).status, 200);
  assert.equal((await media("/fake/media/old-user.pdf")).status, 404, "只開放 Bot 傳來的檔案");
});

test("文字檔用適合手機閱讀的頁面開啟，內容不會被當成網頁執行", async t => {
  const fake = createFakeHermesGateway({ authRequired: false });
  await fake.start();
  t.after(() => fake.close());
  const raw = Buffer.from("# 會議筆記\n<script>alert(1)</script>\nA & B > C\n");
  fake.addFile("/fake/media/notes.md", raw);
  const { call, media } = await host(t, fake);
  const chat = (await call("/api/assistant/bot-chat", { profile: "default" })).body;
  fake.setTurn({ reply: "筆記 MEDIA:/fake/media/notes.md" });
  await reply(call, chat);

  const view = await media("/fake/media/notes.md", "", { headers: { range: "bytes=0-3" } });
  assert.equal(view.status, 200, "閱讀頁一律回傳完整內容");
  assert.equal(view.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(view.headers.get("content-security-policy"), /default-src 'none'.*sandbox/);
  assert.equal(view.headers.get("content-range"), null);
  const html = await view.text();
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<title>notes\.md<\/title>/);
  assert.match(html, /# 會議筆記\n&lt;script&gt;alert\(1\)&lt;\/script&gt;\nA &amp; B &gt; C\n<\/pre>/);
  assert.equal(/<script/i.test(html), false, "檔案內容不能變成可執行的標籤");

  const saved = await media("/fake/media/notes.md", "&download=1");
  assert.equal(saved.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(saved.headers.get("content-disposition"), /^attachment;/);
  assert.deepEqual(Buffer.from(await saved.arrayBuffer()), raw, "下載保留原始檔案");
});
