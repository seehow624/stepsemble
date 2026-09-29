// CI Playwright suite for how a conversation behaves while an agent works,
// with synthetic agents only (test-support fixtures; no account or model):
//   - a message sent shows "Working for …" and "Thinking" below it at once,
//     and the header's run timer counts from the same moment;
//   - the jump-to-latest control is a round button centred above the message
//     box, "•••" while the agent works and an arrow after, and a tap reaches
//     the latest message;
//   - Send pressed before the conversation has connected keeps the message and
//     sends it once connected;
//   - pictures sent with a message sit above it as thumbnails;
//   - a table in a reply scrolls sideways and keeps its headers on one line.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
import { signInToWorkspace, addWorkspaceProject, newWorkspaceSession } from "./workspace-browser-helpers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR42mP8z8BQz0AEYBxVSF8FAP5FDvcfRYWgAAAAAElFTkSuQmCC", "base64");
const seconds = text => Number((/(\d+)s\b/.exec(text || "") || [])[1]);
// The conversation has connected, as Send itself tells (sendOnceConnected in
// public/app.js); before that a message waits for the connection.
const connected = () => typeof rpc !== "undefined" && !!rpc && !rpc.nativeLoading && !genericInputBlock()
  && !document.querySelector("#input")?.readOnly && !document.querySelector("#btn-send")?.disabled;
const TABLE = [
  "Options",
  "",
  "| Choice | Keys needed | Advantages | Drawbacks |",
  "|---|---|---|---|",
  "| **A. Groq only** | 1 | Transcription and clean-up both run on Groq, with a free tier and no card, and it is the fastest | The clean-up model is not one of the three in the brief; its quality is only known after testing |",
  "| **B. OpenAI only** | 1 | One key covers transcription and clean-up, with steady quality | No free tier and a card is required; transcription costs more than Groq |",
].join("\n");

async function pendingTurn(page, ui, context, route, question, replyText, out, key) {
  await context.route(route, async request => { if (request.request().method() === "POST") await new Promise(resolve => setTimeout(resolve, 2500)); await request.continue(); });
  try {
    await ui.locator("#input").fill(question);
    const started = Date.now();
    await ui.locator("#btn-send").click();
    await ui.waitForSelector("#messages .wl-placeholder .wl-head", { timeout: 1500 });
    const appearedMs = Date.now() - started;
    const read = () => ui.evaluate(() => {
      const holder = document.querySelector("#messages .wl-placeholder");
      return { head: holder?.querySelector(".wl-head-label")?.textContent || "", pulse: holder?.querySelector(".wl-pulse")?.textContent || "",
        afterUser: !!holder?.previousElementSibling?.classList.contains("user"),
        timer: document.querySelector("#run-timer")?.textContent || "", timerRunning: !!document.querySelector("#run-timer")?.classList.contains("running") };
    });
    const first = await read();
    await ui.waitForTimeout(2300);
    const later = await read();
    assert.match(first.head, /^Working/);
    assert.equal(first.pulse, "Thinking");
    assert.equal(first.afterUser, true, "the placeholder sits below the message");
    assert(seconds(later.head) > seconds(first.head), "Working for counts up: " + first.head + " → " + later.head);
    assert.equal(later.timerRunning, true, "the header timer runs while waiting");
    assert(Math.abs(seconds(later.timer) - seconds(later.head)) <= 1, "header " + later.timer + " vs " + later.head);
    await ui.waitForFunction(text => [...document.querySelectorAll("#messages .msg.assistant")].some(node => node.textContent.includes(text)), replyText, { timeout: 20000 });
    await ui.waitForFunction(() => !document.querySelector("#messages .wl-placeholder"), null, { timeout: 5000 });
    out[key] = { appearedMs, head: later.head, timer: later.timer };
  } finally { await context.unroute(route); }
}

export async function runConversationUxBrowserCases(browser) {
  for (const viewport of [{ name: "phone", width: 390, height: 844, mobile: true }, { name: "desktop", width: 1280, height: 860, mobile: false }]) {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-conversation-ux-")));
    let child, context, stage = "fixture";
    try {
      const bin = path.join(home, "bin"), project = path.join(home, "project");
      await fs.mkdir(bin); await fs.mkdir(project);
      const wrap = (name, script) => fs.writeFile(path.join(bin, name), "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(path.join(root, script)) + " \"$@\"\n", { mode: 0o700 });
      await wrap("pi", "test-support/rolling-pi.cjs");
      await wrap("claude", "test-support/desktop-claude-structured-peer.cjs");
      await wrap("hermes", "test-support/fake-acp-agent.cjs");
      const picture = path.join(home, "picture.png");
      await fs.writeFile(picture, PNG);
      const port = await freePort(), base = "http://127.0.0.1:" + port;
      child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: root, stdio: ["ignore", "pipe", "pipe"],
        env: { ...cleanEnvironment(home), HOME: home, PATH: bin + path.delimiter + path.dirname(process.execPath) + path.delimiter + "/usr/bin:/bin",
          PI_HOME: home, PI_BIN: path.join(bin, "pi"), STEPSEMBLE_PORT: String(port), STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_ORPHAN_EXIT: "0",
          STEPSEMBLE_CLAUDE_STRUCTURED: "1", FIXTURE_CLAUDE_STREAM: "1" } });
      await waitForServer(child); child.stdout.resume(); child.stderr.resume();
      context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.mobile, hasTouch: viewport.mobile,
        serviceWorkers: "block", locale: "en-US" });
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark" }));
        new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node.classList?.contains("toast")) (window.__toasts ||= []).push(node.textContent); })
          .observe(document, { childList: true, subtree: true });
      });
      const errors = [], foreign = [];
      await context.route("**/*", route => { if (new URL(route.request().url()).origin !== base) { foreign.push(route.request().url()); return route.abort(); } return route.continue(); });
      const page = await context.newPage(); page.setDefaultTimeout(20000); page.on("pageerror", error => errors.push(error.message));
      const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
      stage = "login";
      await signInToWorkspace(page, base, token);
      await addWorkspaceProject(page, project);
      const out = {};

      stage = "Pi: sent before connecting";
      let ui = await newWorkspaceSession(page, { agentId: "pi", name: "UX Pi" });
      // The conversation's event stream is up; then Send meets two seconds
      // without a connection, as while a conversation opens. Events the
      // stream brings meanwhile are held and handed over when it is back: a
      // conversation that has not connected has no stream to bring them.
      await ui.waitForFunction(() => typeof rpc !== "undefined" && !!rpc?.es && rpc.streamReady === true);
      await ui.evaluate(() => {
        const saved = rpc, stream = saved.es, handler = stream.onmessage, held = [];
        stream.onmessage = event => { held.push(event); };
        rpc = null;
        setTimeout(() => { rpc = saved; stream.onmessage = handler; for (const event of held) handler.call(stream, event); }, 2000);
      });
      await ui.locator("#input").fill("sent before connecting");
      await ui.locator("#btn-send").click();
      assert.equal(await ui.locator("#input").inputValue(), "sent before connecting", "the message stays in the box");
      await ui.waitForFunction(() => [...document.querySelectorAll("#messages .msg.user")].some(node => node.textContent.includes("sent before connecting")), null, { timeout: 10000 });
      assert.equal(await ui.evaluate(() => [...document.querySelectorAll("#messages .msg.user")].filter(node => node.textContent.includes("sent before connecting")).length), 1);
      assert((await ui.evaluate(() => window.__toasts || [])).some(text => /Connecting/.test(text)), "Connecting… was said");
      assert.equal(await ui.locator("#input").inputValue(), "");

      stage = "Pi: jump to latest while working";
      await ui.waitForFunction(() => (document.querySelector("#messages")?.textContent || "").includes("Synthetic rolling chunk 160"), null, { timeout: 20000 })
        .catch(async error => {
          const seen = await ui.evaluate(() => ({ tail: (document.querySelector("#messages")?.textContent || "").slice(-200),
            working: !document.querySelector("#btn-abort")?.classList.contains("hidden"), sid: rpc?.sid || null, ready: rpc?.streamReady ?? null,
            users: document.querySelectorAll("#messages .msg.user").length, replies: document.querySelectorAll("#messages .msg.assistant").length }));
          throw new Error(error.message + " " + JSON.stringify(seen));
        });
      const scrollUp = async () => { for (let index = 0; index < 8; index += 1) { await ui.evaluate(() => { const list = document.querySelector("#messages"); list.scrollTop = 0; list.dispatchEvent(new Event("scroll")); }); await ui.waitForTimeout(60); } };
      const jump = () => ui.evaluate(() => {
        const button = document.querySelector("#scroll-bottom-btn"), composer = document.querySelector(".composer-inner") || document.querySelector(".composer");
        const box = button.getBoundingClientRect(), under = composer.getBoundingClientRect();
        return { visible: !button.classList.contains("hidden") && box.width > 0, working: button.classList.contains("is-working"),
          dots: getComputedStyle(button.querySelector(".scroll-bottom-dots")).display !== "none", arrow: getComputedStyle(button.querySelector(".scroll-bottom-arrow")).display !== "none",
          size: Math.round(box.width) + "x" + Math.round(box.height), centre: Math.round(box.left + box.width / 2 - (under.left + under.width / 2)), above: Math.round(under.top - box.bottom) };
      });
      const atBottom = () => ui.waitForFunction(() => { const list = document.querySelector("#messages"); return list.scrollHeight - list.scrollTop - list.clientHeight < 80; }, null, { timeout: 6000 });
      await scrollUp();
      const working = await jump();
      assert.equal(working.visible, true); assert.equal(working.working, true); assert.equal(working.dots, true); assert.equal(working.arrow, false);
      assert.equal(working.size, "40x40"); assert(Math.abs(working.centre) <= 2, "centred: " + working.centre); assert(working.above >= 4);
      await ui.locator("#scroll-bottom-btn").click();
      await atBottom();
      await ui.locator("#btn-abort").click();
      await ui.waitForFunction(() => document.querySelector("#btn-abort")?.classList.contains("hidden"), null, { timeout: 10000 });
      await scrollUp();
      const idle = await jump();
      assert.equal(idle.visible, true); assert.equal(idle.working, false); assert.equal(idle.arrow, true); assert.equal(idle.dots, false);
      await ui.locator("#scroll-bottom-btn").click();
      await atBottom();
      out.jump = { working: working.size, centre: working.centre };

      stage = "Pi: working at once";
      await pendingTurn(page, ui, context, "**/api/send", "held back for Pi", "Synthetic rolling chunk 3", out, "pi");
      await ui.locator("#btn-abort").click();
      await ui.waitForFunction(() => document.querySelector("#btn-abort")?.classList.contains("hidden"), null, { timeout: 10000 });

      stage = "Pi: picture above the message";
      await ui.locator("#file-input").setInputFiles(picture);
      await ui.waitForFunction(() => document.querySelectorAll("#img-preview img").length === 1);
      await ui.locator("#input").fill("a picture for Pi");
      await ui.locator("#btn-send").click();
      await ui.waitForFunction(() => [...document.querySelectorAll("#messages .msg.user")].some(node => node.textContent.includes("a picture for Pi") && node.querySelector(":scope > .msg-attachments img")));
      const pictured = await ui.evaluate(() => {
        const message = [...document.querySelectorAll("#messages .msg.user")].find(node => node.textContent.includes("a picture for Pi"));
        const gallery = message.querySelector(":scope > .msg-attachments"), bubble = message.querySelector(":scope > .bubble"), thumb = gallery.querySelector(".msg-image-button").getBoundingClientRect();
        return { before: !!(gallery.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING), inBubble: bubble.querySelectorAll("img").length, size: Math.round(thumb.width) };
      });
      assert.equal(pictured.before, true, "thumbnails sit above the text");
      assert.equal(pictured.inBubble, 0);
      assert.equal(pictured.size, viewport.mobile ? 112 : 140);
      await ui.locator("#btn-abort").click();
      out.picture = pictured.size;

      stage = "Claude Code: working at once";
      ui = await newWorkspaceSession(page, { agentId: "claude-code", name: "UX Claude" });
      await ui.waitForFunction(connected, null, { timeout: 20000 });
      await pendingTurn(page, ui, context, "**/api/claude/structured/prompt", "held back for Claude", "fixture:held back for Claude", out, "claude");

      stage = "Claude Code: a table scrolls sideways";
      await ui.locator("#input").fill(TABLE);
      await ui.locator("#btn-send").click();
      await ui.waitForFunction(() => document.querySelectorAll("#messages .md-table-scroll table tbody tr").length === 2, null, { timeout: 20000 });
      const table = await ui.evaluate(() => {
        const scroller = [...document.querySelectorAll("#messages .md-table-scroll")].at(-1);
        const heads = [...scroller.querySelectorAll("thead th")].map(cell => Math.round(cell.getBoundingClientRect().height));
        const line = parseFloat(getComputedStyle(scroller.querySelector("thead th")).lineHeight) || 20;
        return { wider: scroller.scrollWidth > scroller.clientWidth, heads, line, pageFits: document.documentElement.scrollWidth <= innerWidth };
      });
      if (viewport.mobile) assert.equal(table.wider, true, "a wide table scrolls on a phone");
      assert(table.heads.every(height => height < table.line * 2 + 24), "headers on one line: " + JSON.stringify(table));
      assert.equal(table.pageFits, true, "the page itself never scrolls sideways");
      out.table = table.wider ? "scrolls" : "fits";

      stage = "ACP agent: working at once";
      ui = await newWorkspaceSession(page, { agentId: "hermes", name: "UX ACP" });
      await ui.waitForFunction(connected, null, { timeout: 20000 });
      await pendingTurn(page, ui, context, "**/api/hermes/acp/prompt", "held back for ACP", "held back for ACP", out, "acp");
      await ui.waitForFunction(() => document.querySelectorAll("#messages .msg.assistant").length > 0);

      assert.deepEqual(errors, []);
      assert.deepEqual(foreign, []);
      console.log(JSON.stringify({ case: "Conversation UX " + viewport.name, result: "passed", ...out, modelCalls: 0, pageErrors: 0 }));
    } catch (error) {
      throw new Error("Conversation UX " + viewport.name + " at " + stage + ": " + error.message, { cause: error });
    } finally {
      await context?.close();
      if (child) await stopServer(child);
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
