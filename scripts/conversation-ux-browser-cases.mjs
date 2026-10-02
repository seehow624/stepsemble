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
// The header timer reads "5s", "1:05" or "1:02:56".
const clock = text => {
  const match = /(?:(\d+):)?(\d+):(\d+)/.exec(text || "");
  return match ? Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) : seconds(text);
};
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
    assert(Math.abs(clock(later.timer) - seconds(later.head)) <= 1, "header " + later.timer + " vs " + later.head);
    await ui.waitForFunction(text => [...document.querySelectorAll("#messages .msg.assistant")].some(node => node.textContent.includes(text)), replyText, { timeout: 20000 });
    await ui.waitForFunction(() => !document.querySelector("#messages .wl-placeholder"), null, { timeout: 5000 });
    // The run is timed from the send, never from before it.
    await ui.waitForTimeout(1200);
    const took = Math.ceil((Date.now() - started) / 1000);
    const finished = await read();
    assert(clock(finished.timer) <= took + 1, "header " + finished.timer + " after " + took + "s");
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
      // Reading back while the reply streams: the list stays where the person
      // scrolled, also when a frame that keeps the reply in view is already
      // waiting. Frames are held so that moment is certain; before 3.8.25 the
      // waiting frame pulled the list back to the end.
      stage = "Pi: reading back while a follow waits";
      await ui.evaluate(() => {
        const held = [], request = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
        window.__frames = { held, request, cancel };
        window.requestAnimationFrame = callback => 1e6 + held.push(callback) - 1;
        window.cancelAnimationFrame = id => { if (id >= 1e6) held[id - 1e6] = null; else cancel(id); };
      });
      // A frame asked for before the hold runs first; then a piece of the
      // reply asks to be followed, as each one does (its rendering waits for a
      // frame too, so it is asked for here directly).
      await ui.waitForFunction(() => scrollFrame === null, null, { polling: 50, timeout: 10000 });
      assert.equal(await ui.evaluate(() => { scrollBottom(true); return scrollFrame >= 1e6; }), true, "a follow frame is waiting");
      // The page's own scroll handler was added first, so it has run when this
      // listener hears the scroll.
      await ui.evaluate(mobile => new Promise(resolve => {
        const list = document.querySelector("#messages");
        list.addEventListener("scroll", () => resolve(), { once: true });
        list.dispatchEvent(mobile ? new Event("touchmove") : new WheelEvent("wheel", { deltaY: -700 }));
        list.scrollTop = Math.max(0, list.scrollTop - 700);
      }), viewport.mobile);
      const readBack = await ui.evaluate(() => {
        const { held, request, cancel } = window.__frames;
        window.requestAnimationFrame = request; window.cancelAnimationFrame = cancel;
        for (const callback of held.splice(0)) callback?.(performance.now());
        const list = document.querySelector("#messages");
        return { pinned: autoScrollPinned, distance: Math.round(list.scrollHeight - list.scrollTop - list.clientHeight) };
      });
      assert.equal(readBack.pinned, false, "reading back ends following " + JSON.stringify(readBack));
      assert(readBack.distance >= 180, "the list stays where it was scrolled " + JSON.stringify(readBack));
      out.readBack = readBack.distance >= 180;
      stage = "Pi: jump to latest while working";
      const scrollUp = async () => { for (let index = 0; index < 8; index += 1) { await ui.evaluate(() => { const list = document.querySelector("#messages"); list.scrollTop = 0; list.dispatchEvent(new Event("scroll")); }); await ui.waitForTimeout(60); } };
      const jump = () => ui.evaluate(() => {
        const button = document.querySelector("#scroll-bottom-btn"), composer = document.querySelector(".composer-inner") || document.querySelector(".composer");
        const box = button.getBoundingClientRect(), under = composer.getBoundingClientRect(), list = document.querySelector("#messages");
        return { visible: !button.classList.contains("hidden") && box.width > 0, working: button.classList.contains("is-working"),
          dots: getComputedStyle(button.querySelector(".scroll-bottom-dots")).display !== "none", arrow: getComputedStyle(button.querySelector(".scroll-bottom-arrow")).display !== "none",
          size: Math.round(box.width) + "x" + Math.round(box.height), centre: Math.round(box.left + box.width / 2 - (under.left + under.width / 2)), above: Math.round(under.top - box.bottom),
          // For a failure message: where the list is and whether a reply is running.
          scroll: [list.scrollTop, list.clientHeight, list.scrollHeight].map(Math.round), running: !document.querySelector("#btn-abort")?.classList.contains("hidden") };
      });
      const atBottom = () => ui.waitForFunction(() => { const list = document.querySelector("#messages"); return list.scrollHeight - list.scrollTop - list.clientHeight < 80; }, null, { timeout: 6000 });
      await scrollUp();
      const working = await jump();
      const seen = JSON.stringify(working);
      assert.equal(working.visible, true, "visible " + seen); assert.equal(working.working, true, "working " + seen);
      assert.equal(working.dots, true, "dots " + seen); assert.equal(working.arrow, false, "arrow " + seen);
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

      stage = "Pi: typing does not move the conversation";
      // At the end of a long reply that has just come in, as when answering it.
      const typer = await newWorkspaceSession(page, { agentId: "pi", name: "UX Typing" });
      await typer.waitForFunction(() => typeof rpc !== "undefined" && !!rpc?.es && rpc.streamReady === true);
      await typer.locator("#input").fill("Synthetic streaming"); await typer.locator("#btn-send").click();
      await typer.waitForFunction(() => (document.querySelector("#messages")?.textContent || "").includes("Synthetic rolling chunk 250"), null, { timeout: 30000 });
      await typer.locator("#btn-abort").click();
      await typer.waitForFunction(() => document.querySelector("#btn-abort")?.classList.contains("hidden"), null, { timeout: 10000 });
      await typer.evaluate(() => { const list = document.querySelector("#messages"); list.scrollTop = list.scrollHeight; });
      await typer.waitForTimeout(300);
      // Where the latest reply sits on screen, and how tall the box is.
      const place = () => typer.evaluate(() => { const list = document.querySelector("#messages");
        return { anchor: Math.round([...list.querySelectorAll(".msg")].at(-1).getBoundingClientRect().top),
          box: Math.round(document.querySelector("#input").getBoundingClientRect().height), end: Math.round(list.scrollHeight - list.scrollTop - list.clientHeight) }; });
      const typing = { start: await place(), steps: [] };
      await typer.locator("#input").click();
      for (const line of ["first line of text", "second line", "third line", "fourth line"]) {
        await typer.locator("#input").pressSequentially(line, { delay: 5 });
        await typer.locator("#input").press("Shift+Enter");
        typing.steps.push(await place());
      }
      assert(typing.steps.at(-1).box > typing.start.box, "the box grew: " + JSON.stringify(typing));
      assert(typing.steps.every(step => Math.abs(step.anchor - typing.start.anchor) <= 1), "the conversation stayed where it was: " + JSON.stringify(typing));
      // iOS nudges the visual viewport as lines are added; only the keyboard
      // coming or going brings the latest message back.
      const nudge = await typer.evaluate(async () => {
        const list = document.querySelector("#messages");
        list.scrollTop -= 40;
        await new Promise(resolve => setTimeout(resolve, 60));
        const before = list.scrollTop;
        window.visualViewport?.dispatchEvent(new Event("scroll"));
        window.visualViewport?.dispatchEvent(new Event("resize"));
        await new Promise(resolve => setTimeout(resolve, 120));
        return { before, after: list.scrollTop };
      });
      assert(Math.abs(nudge.after - nudge.before) <= 1, "a viewport nudge left the conversation alone: " + JSON.stringify(nudge));
      await typer.locator("#input").fill("");
      out.typing = { grew: typing.steps.at(-1).box - typing.start.box, moved: Math.max(...typing.steps.map(step => Math.abs(step.anchor - typing.start.anchor))) };

      stage = "Claude Code: working at once";
      ui = await newWorkspaceSession(page, { agentId: "claude-code", name: "UX Claude" });
      await ui.waitForFunction(connected, null, { timeout: 20000 });
      // Claude has been open a while when the message goes, as in a
      // conversation opened earlier: the turn is still timed from the send.
      await ui.waitForTimeout(6000);
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

      stage = "Tabs: one width, the agent's logo, no title row";
      if (viewport.mobile) {
        const head = await ui.evaluate(() => ({ title: getComputedStyle(document.querySelector("#chat-head-info")).display !== "none",
          back: getComputedStyle(document.querySelector("#btn-back")).display !== "none" }));
        assert.deepEqual(head, { title: true, back: true }, "a phone keeps the title row with Back");
        out.tabs = "phone title row";
      } else {
        const tabs = await page.evaluate(() => [...document.querySelectorAll(".workspace-tab")].map(tab => ({
          width: Math.round(tab.getBoundingClientRect().width), agent: tab.querySelector(".agent-logo")?.dataset.agentId || null })));
        assert.deepEqual(tabs.map(tab => tab.agent), ["pi", "pi", "claude-code", "hermes"], JSON.stringify(tabs));
        assert.equal(new Set(tabs.map(tab => tab.width)).size, 1, "every tab has one width: " + JSON.stringify(tabs));
        const pane = await ui.evaluate(() => {
          const shown = selector => { const node = document.querySelector(selector); return !!node && getComputedStyle(node).display !== "none" && node.getBoundingClientRect().width > 0; };
          const menu = document.querySelector("#btn-chat-menu").getBoundingClientRect();
          return { title: shown("#chat-head-info"), path: shown("#chat-sub"), timer: shown("#run-timer"), menu: shown("#btn-chat-menu"),
            corner: menu.top < 60 && innerWidth - menu.right < 40, messagesTop: Math.round(document.querySelector("#messages").getBoundingClientRect().top) };
        });
        assert.deepEqual({ title: pane.title, path: pane.path, timer: pane.timer, menu: pane.menu, corner: pane.corner },
          { title: false, path: false, timer: false, menu: true, corner: true }, JSON.stringify(pane));
        assert(pane.messagesTop <= 2, "the conversation starts at the top of the pane: " + pane.messagesTop);
        out.tabs = tabs[0].width + "px with logos";

        stage = "Refresh reads the allowances again";
        const asked = page.waitForRequest(request => { const url = new URL(request.url()); return url.pathname === "/api/workspace/usage" && url.searchParams.get("fresh") === "1"; });
        await page.locator("#workspace-refresh").click();
        await asked;
        out.limits = "fresh on Refresh";
      }

      stage = "Settings open in the same window";
      // On a phone the list, with the Settings button, is behind the open conversation.
      if (viewport.mobile) {
        await ui.evaluate(() => parent.postMessage({ type: "workspace-show-list" }, location.origin));
        await page.waitForFunction(() => !document.body.classList.contains("sidebar-hidden"));
      }
      await ui.evaluate(() => { window.__paneKept = true; });
      const pagesBefore = context.pages().length;
      const settingsLayer = async () => {
        await page.locator("#workspace-settings").click();
        await page.waitForSelector(".workspace-settings-layer iframe");
        const frame = await (await page.$(".workspace-settings-layer iframe")).contentFrame();
        await frame.waitForFunction(() => {
          const view = document.querySelector("#view-settings");
          return !!view && !view.classList.contains("hidden") && view.getBoundingClientRect().height > 200;
        }, null, { timeout: 20000 }).catch(async error => {
          const seen = await frame.evaluate(() => ({ url: location.href, views: [...document.querySelectorAll("main, .view, #onboarding, #login")].map(node => (node.id || node.className) + ":" + (node.classList.contains("hidden") ? "hidden" : Math.round(node.getBoundingClientRect().height))) })).catch(() => null);
          await page.screenshot({ path: path.join(os.tmpdir(), "stepsemble-settings-layer-" + viewport.name + ".png") }).catch(() => {});
          throw new Error(error.message + " " + JSON.stringify(seen));
        });
        return frame;
      };
      let settings = await settingsLayer();
      if (process.env.STEPSEMBLE_UX_SHOTS) {
        await page.waitForTimeout(700);
        await page.screenshot({ path: path.join(process.env.STEPSEMBLE_UX_SHOTS, "settings-same-window-" + viewport.name + ".png") });
      }
      const shown = await page.evaluate(() => {
        const layer = document.querySelector(".workspace-settings-layer").getBoundingClientRect();
        return { url: location.pathname, width: Math.round(layer.width), height: Math.round(layer.height), inert: document.querySelector("#workspace-main").inert };
      });
      assert.deepEqual([shown.url, shown.width, shown.height, shown.inert], ["/workspace.html", viewport.width, viewport.height, true]);
      assert.equal(context.pages().length, pagesBefore, "no second window");
      await settings.locator("#btn-settings-back").click();
      await page.waitForFunction(() => !document.querySelector(".workspace-settings-layer"), null, { timeout: 5000 });
      settings = await settingsLayer();
      await settings.locator("#view-settings").press("Escape");
      await page.waitForFunction(() => !document.querySelector(".workspace-settings-layer"), null, { timeout: 5000 });
      assert.equal(context.pages().length, pagesBefore, "no second window");
      assert.equal(page.url().includes("/workspace.html"), true);
      assert.equal(await page.evaluate(() => document.querySelector("#workspace-main").inert), false);
      assert.equal(await ui.evaluate(() => window.__paneKept === true), true, "the conversation pane was not reloaded");
      out.settings = "same window";

      stage = "The Mac app's window keeps every control clear of its buttons and of the strip that moves it";
      {
        // What the app tells the page (WindowChrome in main.swift), in CSS pixels.
        const chrome = { "titlebar-height": 52, "controls-start": 20, "controls-end": 78, "controls-center": 26, "controls-bottom": 33 };
        await page.evaluate(chrome => {
          window.__dragRegions = null;
          window.webkit = { messageHandlers: { stepsemble: { postMessage: message => { if (message?.type === "drag-regions") window.__dragRegions = message.rects; } } } };
          const root = document.documentElement;
          root.dataset.macWindow = "chromeless";
          for (const [name, value] of Object.entries(chrome)) root.style.setProperty("--mac-" + name, value + "px");
          dispatchEvent(new Event("stepsemble-mac-window"));
        }, chrome);
        const problem = () => page.evaluate(chrome => {
          const rects = window.__dragRegions;
          if (!rects?.length) return "nothing moves the window";
          const buttons = { left: chrome["controls-start"], right: chrome["controls-end"], top: 2 * chrome["controls-center"] - chrome["controls-bottom"], bottom: chrome["controls-bottom"] };
          const regions = rects.map(([x, y, w, h]) => ({ left: x, top: y, right: x + w, bottom: y + h }));
          // Regions are whole pixels, so one may reach half a pixel into a neighbour.
          const overlaps = (a, b) => a.left + 1 < b.right && b.left + 1 < a.right && a.top + 1 < b.bottom && b.top + 1 < a.bottom;
          for (const element of document.querySelectorAll("button, select, input, iframe, [role=tab], .workspace-divider")) {
            const box = element.getBoundingClientRect();
            if (box.width < 2 || box.height < 2) continue;
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            if (!hit || (hit !== element && !element.contains(hit))) continue;
            const name = element.id || element.getAttribute("aria-label") || element.className || element.tagName;
            if (overlaps(box, buttons)) return name + " is under the window's buttons";
            if (regions.some(region => overlaps(box, region))) return name + " is in the strip that moves the window";
          }
          return "";
        }, chrome);
        const clear = async state => {
          let found = "";
          for (let attempt = 0; attempt < 30; attempt++) {
            found = await problem();
            if (!found) return;
            await page.waitForTimeout(100);
          }
          throw new Error(state + ": " + found);
        };
        await clear("with the list");
        if (viewport.mobile) {
          await page.locator(".workspace-session").first().click();
          await page.waitForFunction(() => document.body.classList.contains("sidebar-hidden"));
          await clear("with a conversation open");
          await page.evaluate(() => history.back());
          await page.waitForFunction(() => !document.body.classList.contains("sidebar-hidden"));
        } else {
          const toggle = page.locator(".workspace-strip-button[data-edge=start]");
          await toggle.click();
          await page.waitForFunction(() => document.body.classList.contains("sidebar-hidden"));
          await clear("with the list hidden");
          await toggle.click();
          await page.waitForFunction(() => !document.body.classList.contains("sidebar-hidden"));
        }
        await page.locator("#workspace-settings").click();
        await page.waitForSelector(".workspace-settings-layer iframe");
        await clear("with Settings open");
        await (await (await page.$(".workspace-settings-layer iframe")).contentFrame()).locator("#btn-settings-back").click();
        await page.waitForFunction(() => !document.querySelector(".workspace-settings-layer"), null, { timeout: 5000 });
        await page.evaluate(chrome => {
          const root = document.documentElement;
          delete root.dataset.macWindow;
          for (const name of Object.keys(chrome)) root.style.removeProperty("--mac-" + name);
          delete window.webkit;
          dispatchEvent(new Event("stepsemble-mac-window"));
        }, chrome);
        out.macWindow = "controls clear";
      }

      stage = "A provider switched off in Settings leaves every model menu";
      settings = await settingsLayer();
      await settings.evaluate(() => showModelSettings({ agent: "pi" }));
      const providerSwitch = settings.locator('[data-provider-visibility="synthetic"]');
      await providerSwitch.waitFor({ state: "attached", timeout: 20000 });
      assert.equal(await providerSwitch.isChecked(), true);
      await providerSwitch.click({ force: true });
      await settings.waitForFunction(() => document.querySelector('[data-provider-visibility="synthetic"]')?.closest(".model-provider-group")?.classList.contains("provider-hidden"));
      const kept = async () => (await (await context.request.get(base + "/api/model-visibility")).json()).hidden;
      for (let tries = 0; tries < 20 && !(await kept()).includes("synthetic::*"); tries += 1) await page.waitForTimeout(100);
      assert.deepEqual(await kept(), ["synthetic::*"], "kept on the Host");
      // A pane reads the Host's list, as another device does.
      assert.equal(await ui.evaluate(async () => { await loadHostModelVisibility(); return isModelVisible({ provider: "synthetic", id: "baseline" }); }), false);
      await providerSwitch.click({ force: true });
      for (let tries = 0; tries < 20 && (await kept()).length; tries += 1) await page.waitForTimeout(100);
      assert.deepEqual(await kept(), []);
      await settings.locator("#view-settings").press("Escape");
      out.providers = "hidden on the Host";

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
