// The bounded four-cell experiment contradicted this model. Explicit diagnostic
// only: no automatic worker hook, production oracle, CSS repair or browser launch.
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const FROZEN = Object.freeze({
  background: [0, 0, 1084, 828, 0],
  bar: [132, 667.171875, 952, 705, 0],
  composer: [132, 705, 952, 820, 28],
  line: [133, 688, 951, 712, 0],
  native: [132, 671.171875, 367.328125, 701, 0],
  nativeButton: [132, 671.171875, 367.328125, 701, 999],
  goal: [375.328125, 671.171875, 545.75, 701, 0],
  goalButton: [375.328125, 671.171875, 545.75, 701, 999],
  bubble: [553.75, 671.171875, 705.734375, 701, 999],
});
const ids = Object.keys(FROZEN);
const owners = ["native", "goal", "bubble", "line", "composer", "background"];
const topOwner = target => ({ nativeButton: "native", goalButton: "goal" })[target] || target;
const ancestry = target => target === "nativeButton" ? [target, "native"] : target === "goalButton" ? [target, "goal"] : [target];

// Outward device-cell coverage is an UNPROVED hit-testing hypothesis. A cell
// intersects a rounded rectangle iff its distance to the inset rectangle is
// less than the radius; mere tangency (zero area) is excluded. No hit input.
function covers(rect, x, y, dpr) {
  const [l, t, r, b, radius] = rect;
  const x0 = Math.floor(x * dpr) / dpr, y0 = Math.floor(y * dpr) / dpr;
  const x1 = x0 + 1 / dpr, y1 = y0 + 1 / dpr;
  if (x1 <= l || x0 >= r || y1 <= t || y0 >= b) return false;
  const rad = Math.min(radius, (r - l) / 2, (b - t) / 2);
  if (!rad) return true;
  const dx = Math.max(l + rad - x1, x0 - (r - rad), 0);
  const dy = Math.max(t + rad - y1, y0 - (b - rad), 0);
  return dx * dx + dy * dy < rad * rad;
}
export function predictDockOwner(x, y, dpr) {
  assert.ok([1, 2].includes(dpr));
  assert.ok(Number.isFinite(x) && Number.isFinite(y));
  // bar is pointer-events:none; its rectangular active groups are NOT clipped
  // to their rounded descendants. Bar z2 precedes line z1, then composer.
  for (const target of ["bubble", "goalButton", "goal", "nativeButton", "native", "line", "composer", "background"]) {
    if (covers(FROZEN[target], x, y, dpr)) return { owner: topOwner(target), target };
  }
  return { owner: "unknown", target: "unknown" };
}

export function dockSamples(dpr) {
  assert.ok([1, 2].includes(dpr));
  const points = [];
  const add = (id, kind, x, y, click = false) => points.push({ id, kind, x, y, click, expected: predictDockOwner(x, y, dpr) });
  for (let x = 141; x < 943; x += 6) add(`original-${x}`, "original", x, 690);
  // The two physical-cell centers adjacent to every relevant bounding edge.
  // Curved edges have additional fixed corner controls below; none are hit-selected.
  for (const name of ["line", "native", "goal", "bubble", "bar", "composer"]) {
    const [l, t, r, b] = FROZEN[name];
    for (const [edge, value, horizontal] of [["left", l, true], ["right", r, true], ["top", t, false], ["bottom", b, false]]) {
      for (const [side, cell] of [["before", Math.ceil(value * dpr - 0.5) - 1], ["after", Math.floor(value * dpr - 0.5) + 1]]) {
        const v = (cell + 0.5) / dpr;
        add(`${name}-${edge}-${side}`, "edge", horizontal ? v : (l + r) / 2, horizontal ? (t + b) / 2 : v);
      }
    }
  }
  for (const x of [374, 375, 376]) add(`neighbor-${x}`, "boundary", x, 690, true);
  add("native-goal-gap", "gap", 371, 690, true);
  add("goal-bubble-gap", "gap", 550, 690, true);
  for (const name of ["native", "goal", "bubble"]) {
    const [l, t, r, b] = FROZEN[name];
    for (const [corner, x, y] of [["tl", l, t], ["tr", r, t], ["bl", l, b], ["br", r, b]]) {
      const sx = x === l ? 1 : -1, sy = y === t ? 1 : -1;
      add(`${name}-${corner}-outer`, "corner", x + sx * 0.25, y + sy * 0.25, true);
      add(`${name}-${corner}-inner`, "corner", x + sx * 6, y + sy * 6, true);
    }
  }
  assert.equal(new Set(points.map(p => p.id)).size, points.length);
  assert.equal(points.filter(p => p.kind === "original").length, 134);
  return points;
}

// Frozen sizes, not font-dependent label widths. The native/goal rectangular
// groups remain active behind full-size rounded buttons. Source styling:
// style.css:684-687,781-809,7061-7092; workflows.css:187-202.
export const DOCK_FIXTURE = `<!doctype html><meta charset="utf-8"><title>Owned dock boundary fixture</title>
<style>
*{box-sizing:border-box}html,body{margin:0;width:1084px;height:828px}
#background{position:absolute;inset:0;z-index:20;display:flex;flex-direction:column;padding-top:667.171875px;overflow-x:hidden;overflow-y:auto}
#bar{position:relative;z-index:2;display:flex;flex-wrap:wrap;align-items:center;column-gap:8px;pointer-events:none;width:820px;height:37.828125px;align-self:center;flex:none}
#bar>*{pointer-events:auto;flex:0 1 auto;min-width:0;max-width:100%}
#native,#goal{display:inline-flex;align-items:stretch;margin:4px 0;height:29.828125px}
#native{width:235.328125px}#goal{width:170.421875px}
button{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:100%;padding:4px 12px;border:1px solid #888;border-radius:999px;background:#fff;color:#111;font:inherit;font-size:.8rem;white-space:nowrap;cursor:pointer}
#nativeButton,#goalButton{width:100%;height:100%;margin:0;flex:0 1 auto}
#goalButton::before,#bubble::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:#888}
#bubble{order:1;gap:8px;width:151.984375px;height:29.828125px;margin:4px 0}
#composer{display:flex;position:relative;align-self:center;flex:none;width:820px;height:115px;border:1px solid #888;border-radius:28px;overflow:visible}
#line{display:block;position:absolute;z-index:1;top:-18px;left:0;right:0;height:24px;border-radius:0;cursor:pointer;touch-action:pan-y;user-select:none}
</style>
<main id="background"><div id="bar"><section id="native"><button id="nativeButton" type="button"></button></section><span id="goal"><button id="goalButton" type="button"></button></span><button id="bubble" type="button"></button></div><footer id="composer"><div id="line"></div></footer></main>`;

export function isOwnedFixtureRequest(url, origin) {
  try {
    const u = new URL(url), o = new URL(origin);
    return o.protocol === "http:" && o.hostname === "127.0.0.1" && !!o.port && u.origin === o.origin
      && u.pathname === "/" && !u.search && !u.hash && !u.username && !u.password;
  } catch { return false; }
}
const sha = data => createHash("sha256").update(data).digest("hex");
export function summarizeDockSamples(samples) {
  const original = samples.filter(p => p.kind === "original");
  const count = field => Object.fromEntries(owners.concat("unknown").map(owner => [owner, original.filter(p => p[field]?.owner === owner).length]));
  return { total: samples.length, uniqueIds: new Set(samples.map(p => p.id)).size, original: original.length,
    predicted: count("expected"), observed: count("observed"), contradictions: samples.filter(p => p.matches === false).map(p => p.id) };
}

export function assessDockClick(expected, events) {
  const listeners = target => [...ancestry(target), ...(target === "line" ? ["composer"] : []), ...(target !== "background" ? ["background"] : [])];
  const vector = target => ["pointerdown", "pointerup", "click"].flatMap(type => ["document", ...listeners(target)].map(listener => ({ listener, type, target, trusted: true })));
  const expectedListeners = listeners(expected.target), expectedEvents = vector(expected.target);
  // Validate actual propagation independently before comparing the hypothesis.
  // A coherent different owner is a contradiction; missing/competing events are HOLD.
  const actualTarget = events.find(e => e.listener === "document")?.target;
  const targets = ["native", "nativeButton", "goal", "goalButton", "bubble", "line", "composer", "background"];
  const mechanismValid = targets.includes(actualTarget) && JSON.stringify(events) === JSON.stringify(vector(actualTarget));
  const counters = Object.fromEntries(targets.map(id => [id, events.filter(e => e.listener === id && e.type === "click").length]));
  return { expectedListeners, expectedEvents, events, counters, mechanismValid,
    matches: mechanismValid && topOwner(actualTarget) === expected.owner && actualTarget === expected.target };
}

function withinDockDeadline(promise, deadline) {
  let timer;
  const bound = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("dock-bound"), { code: "dock-bound" })), Math.max(0, deadline - performance.now()));
  });
  return Promise.race([Promise.resolve(promise), bound]).finally(() => clearTimeout(timer));
}

// The same deadline covers creation, observations AND closure. Never wait again
// after it expires; late-owned contexts are closed without closing caller browser.
export async function runDockContextLifecycle(browser, options, observe, { boundMs = 12000, onLateCleanup = null } = {}) {
  assert.ok(Number.isFinite(boundMs) && boundMs > 0 && boundMs <= 12000);
  assert.ok(onLateCleanup === null || typeof onLateCleanup === "function");
  const started = performance.now(), deadline = started + boundMs;
  const result = { failures: [], contextClosed: false, lateCleanup: "none", elapsedMs: 0 }, controller = new AbortController();
  let context, finished = false, closePromise;
  const closeOwned = () => closePromise ||= Promise.resolve().then(() => context.close());
  const contextPromise = Promise.resolve().then(() => browser.newContext(options)).then(value => {
    context = value;
    if (finished) {
      result.lateCleanup = "pending";
      closeOwned().then(() => {
        result.lateCleanup = "closed"; onLateCleanup?.({ status: "closed" });
      }, () => {
        result.lateCleanup = "failed"; result.failures.push("late-context-cleanup");
        onLateCleanup?.({ status: "failed" });
      }).catch(() => { result.failures.push("late-cleanup-receipt"); });
    }
    return value;
  });
  const work = contextPromise.then(value => finished ? undefined : observe(value, controller.signal));
  try { await withinDockDeadline(work, deadline); }
  catch (error) { result.failures.push(error?.code === "dock-bound" ? "context-bound" : "fixture-or-mechanism"); }
  finally {
    finished = true;
    controller.abort();
    if (context) {
      try { await withinDockDeadline(closeOwned(), deadline); result.contextClosed = true; }
      catch { result.failures.push("context-cleanup-incomplete"); }
    } else result.failures.push("context-cleanup-incomplete");
    result.elapsedMs = performance.now() - started;
    if (result.elapsedMs > boundMs && !result.failures.includes("context-bound")) result.failures.push("context-bound");
  }
  return result;
}

// Caller owns the already-launched pinned browser. Returns two JSON-safe records;
// result=complete is NOT acceptance. HOLD is distinct from hypothesis contradiction.
export async function runDockHitBoundaryDiagnostic(browser, { engine } = {}) {
  assert.ok((engine === "chromium" && process.platform === "linux") || (engine === "webkit" && process.platform === "darwin"), "Only the predeclared Linux Chromium / macOS WebKit cells");
  assert.equal(browser.browserType().name(), engine);
  const experimentDeadline = performance.now() + 24000;
  const sourceSha256 = sha(await withinDockDeadline(readFile(new URL(import.meta.url)), experimentDeadline));
  const serverRequests = [], records = [];
  let origin, serverError = false;
  const server = http.createServer((req, res) => {
    const owned = req.method === "GET" && req.headers.host === new URL(origin).host && isOwnedFixtureRequest(`http://${req.headers.host}${req.url}`, origin);
    serverRequests.push({ owned, method: req.method === "GET" ? "GET" : "other" });
    res.writeHead(owned ? 200 : 403, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'" });
    res.end(owned ? DOCK_FIXTURE : "refused");
  });
  try {
    await withinDockDeadline(new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }), experimentDeadline);
    server.on("error", () => { serverError = true; });
    origin = `http://127.0.0.1:${server.address().port}`;
    for (const dpr of [1, 2]) {
      const record = { schema: "dock-hit-boundary-v1", experiment: "unproved-outward-device-cell", result: "hold", hypothesisStatus: "untested",
        engine, browserVersion: browser.version(), os: { platform: process.platform, release: os.release(), arch: process.arch },
        dpr, viewport: { width: 1084, height: 828 }, boundMs: 12000, sourceSha256, fixtureSha256: sha(DOCK_FIXTURE),
        predictions: dockSamples(dpr), observations: [], clicks: [], failures: [], foreignOrigins: [], pageErrors: 0, cleanup: { context: false, server: false } };
      records.push(record);
      const contextBudgetMs = Math.min(12000, experimentDeadline - performance.now());
      if (contextBudgetMs <= 0) { record.failures.push("experiment-bound"); break; }
      const lifecycle = await runDockContextLifecycle(browser,
        { viewport: record.viewport, deviceScaleFactor: dpr, serviceWorkers: "block", reducedMotion: "reduce" }, async (context, signal) => {
        await context.route("**/*", async route => {
          if (!isOwnedFixtureRequest(route.request().url(), origin)) {
            record.foreignOrigins.push(new URL(route.request().url()).origin);
            return route.abort();
          }
          return route.continue();
        });
        const page = await context.newPage();
        page.setDefaultTimeout(12000);
        page.on("pageerror", () => { record.pageErrors++; });
        await page.goto(origin + "/", { waitUntil: "load", timeout: 12000 });
        record.geometry = await page.evaluate(ids => {
          const styles = (el, pseudo) => {
            const s = getComputedStyle(el, pseudo);
            return Object.fromEntries(["display", "position", "pointerEvents", "zIndex", "overflowX", "overflowY", "borderRadius", "transform", "borderWidth", "boxSizing", "margin", "padding", "width", "height", "content"].map(k => [k, s[k]]));
          };
          return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
            visualViewport: { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale, offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop },
            elements: Object.fromEntries(ids.map(id => {
              const el = document.getElementById(id), r = el.getBoundingClientRect();
              return [id, { rect: [r.left, r.top, r.right, r.bottom], style: styles(el), before: styles(el, "::before"), after: styles(el, "::after") }];
            })) };
        }, ids);
        assert.deepEqual(record.geometry.viewport, { width: 1084, height: 828, dpr });
        assert.deepEqual(record.geometry.visualViewport, { width: 1084, height: 828, scale: 1, offsetLeft: 0, offsetTop: 0 });
        for (const id of ids) {
          const { rect, style } = record.geometry.elements[id];
          assert.deepEqual(rect, FROZEN[id].slice(0, 4));
          assert.equal(style.borderRadius, `${FROZEN[id][4]}px`);
          assert.equal(style.pointerEvents, id === "bar" ? "none" : "auto");
          assert.equal(style.transform, "none");
          assert.equal(style.overflowX, id === "background" ? "hidden" : "visible");
          assert.equal(style.overflowY, id === "background" ? "auto" : "visible");
        }
        assert.equal(record.geometry.elements.bar.style.zIndex, "2");
        assert.equal(record.geometry.elements.line.style.zIndex, "1");
        // All predictions already exist in record before this first hit query.
        record.observations = await page.evaluate(points => points.map(p => {
          const hit = document.elementFromPoint(p.x, p.y);
          const target = hit?.id || "unknown";
          return { id: p.id, target, stack: document.elementsFromPoint(p.x, p.y).map(el => el.id || "unknown") };
        }), record.predictions);
        record.samples = record.predictions.map((p, i) => {
          const target = record.observations[i].target;
          const observed = { owner: topOwner(target), target };
          return { ...p, observed, matches: observed.owner === p.expected.owner && target === p.expected.target };
        });
        await page.evaluate(ids => {
          window.dockEvents = [];
          const targetId = e => e.target.id || "unknown";
          for (const type of ["pointerdown", "pointerup", "click"]) {
            document.addEventListener(type, e => window.dockEvents.push({ listener: "document", type, target: targetId(e), trusted: e.isTrusted }), true);
            for (const id of ids) document.getElementById(id).addEventListener(type, e => window.dockEvents.push({ listener: id, type, target: targetId(e), trusted: e.isTrusted }));
          }
        }, ["native", "nativeButton", "goal", "goalButton", "bubble", "line", "composer", "background"]);
        for (const p of record.predictions.filter(p => p.click)) {
          signal.throwIfAborted();
          await page.evaluate(() => { window.dockEvents = []; });
          signal.throwIfAborted();
          await page.mouse.click(p.x, p.y);
          const events = await page.evaluate(() => window.dockEvents);
          const assessment = assessDockClick(p.expected, events);
          // Broken/untrusted input is HOLD, not a model contradiction.
          record.clicks.push({ id: p.id, x: p.x, y: p.y, expected: p.expected, ...assessment });
          if (!assessment.mechanismValid) record.failures.push(`trusted-input-${p.id}`);
          assert.ok(assessment.mechanismValid, "trusted-input-mechanism");
          assert.equal(record.pageErrors, 0, "pageerror");
          assert.equal(record.foreignOrigins.length, 0, "foreign-origin");
        }
        record.summary = summarizeDockSamples(record.samples);
        record.hypothesisStatus = record.summary.contradictions.length || record.clicks.some(c => !c.matches) ? "contradicted" : "supported";
        if (record.foreignOrigins.length) record.failures.push("foreign-origin");
        if (record.pageErrors) record.failures.push("pageerror");
      }, { boundMs: contextBudgetMs, onLateCleanup: receipt => {
        record.lateContextCleanup = receipt.status;
        if (receipt.status === "failed" && !record.failures.includes("late-context-cleanup")) record.failures.push("late-context-cleanup");
        console.log(JSON.stringify({ schema: "dock-hit-boundary-late-cleanup-v1", engine, dpr, status: receipt.status, sourceSha256, fixtureSha256: record.fixtureSha256 }));
      } });
      record.lifecycle = lifecycle; // Preserve live late state as well as explicit receipts.
      for (const failure of lifecycle.failures) if (!record.failures.includes(failure)) record.failures.push(failure);
      record.cleanup.context = lifecycle.contextClosed;
      record.lateContextCleanup ??= lifecycle.lateCleanup;
      record.elapsedMs = lifecycle.elapsedMs;
      record.contextBudgetMs = contextBudgetMs;
      if (record.pageErrors && !record.failures.includes("pageerror")) record.failures.push("pageerror");
      if (record.foreignOrigins.length && !record.failures.includes("foreign-origin")) record.failures.push("foreign-origin");
      if (record.failures.length) break;
    }
  } finally {
    let closed = false;
    try {
      await withinDockDeadline(new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }), experimentDeadline);
      closed = true;
    } catch { closed = false; }
    finally {
      for (const record of records) {
        record.cleanup.server = closed;
        record.serverRequests = serverRequests;
        if (!closed) record.failures.push("server-cleanup");
        if (serverError || serverRequests.some(r => !r.owned)) record.failures.push("fixture-server");
        record.result = record.failures.length ? "hold" : "complete";
      }
    }
  }
  return records;
}
