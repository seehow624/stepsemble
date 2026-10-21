"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { levelStops, stopFraction, nearestStop, linePlace, nearestPlace, project, landingStop, rubberband, springStep } = require("../public/modules/effort-slider");

const option = (value, label = value, disabled = false) => ({ value, label, disabled });

test("a model's levels become stops from the weakest on the left to the strongest on the right", () => {
  // Claude's own list.
  assert.deepEqual(levelStops(["low", "medium", "high", "xhigh", "max"]).stops, ["low", "medium", "high", "xhigh", "max"]);
  // Grok lists its levels from Extra high down.
  assert.deepEqual(levelStops(["xhigh", "high", "medium", "low"]).stops, ["low", "medium", "high", "xhigh"]);
  // Pi: off is the leftmost stop; levels this model does not take are not stops.
  const pi = levelStops([option("off", "Off"), option("minimal", "Minimal", true), option("low", "Low"), option("medium", "Medium"), option("high", "High"),
    option("xhigh", "Extra high", true), option("max", "Max", true)]);
  assert.deepEqual(pi.stops, ["off", "low", "medium", "high"]);
  assert.equal(pi.labels.get("high"), "High");
  // Codex's Ultra tops the list; "none" counts as off.
  assert.deepEqual(levelStops(["ultra", "max", "none", "low"]).stops, ["none", "low", "max", "ultra"]);
  // Auto is not a stop but is offered beside the line; the unknown placeholder is neither.
  const offered = levelStops([option("", "—", true), option("auto", "Auto"), option("low"), option("high")]);
  assert.deepEqual([offered.stops, offered.auto], [["low", "high"], "auto"]);
  assert.equal(levelStops(["low", "high"]).auto, null);
  // Names of an agent's own keep the agent's order, with off first.
  assert.deepEqual(levelStops(["quick", "off", "deep"]).stops, ["off", "quick", "deep"]);
  assert.deepEqual(levelStops(["low", "low", ""]).stops, ["low"]);
  assert.deepEqual(levelStops(null).stops, []);
});

test("a stop and its place on the line map to each other", () => {
  for (const count of [2, 3, 5, 7]) {
    for (let index = 0; index < count; index++) {
      assert.equal(nearestStop(stopFraction(index, count), count), index, `${index} of ${count}`);
    }
  }
  assert.equal(stopFraction(0, 5), 0);
  assert.equal(stopFraction(4, 5), 1);
  assert.equal(stopFraction(2, 5), 0.5);
  // A single level sits at the strong end.
  assert.equal(stopFraction(0, 1), 1);
  assert.equal(nearestStop(0.3, 1), 0);
  // Between stops, the nearer one; past the ends, the end.
  assert.equal(nearestStop(0.6, 5), 2);
  assert.equal(nearestStop(0.65, 5), 3);
  assert.equal(nearestStop(-0.4, 5), 0);
  assert.equal(nearestStop(1.7, 5), 4);
});

test("on the message box's edge the weakest level is a stub, the strongest the whole line and off the empty one", () => {
  const claude = ["low", "medium", "high", "xhigh", "max"];
  assert.deepEqual(claude.map((stop, index) => +linePlace(index, claude).toFixed(3)), [0.1, 0.325, 0.55, 0.775, 1]);
  const pi = ["off", "low", "medium", "high"];
  assert.deepEqual(pi.map((stop, index) => +linePlace(index, pi).toFixed(3)), [0, 0.1, 0.55, 1]);
  assert.equal(linePlace(0, ["high"]), 1, "a lone level fills the line");
  assert.equal(linePlace(0, ["none"]), 0);
  assert.equal(linePlace(-1, claude), 0, "an unknown level, the empty line");
  assert.equal(linePlace(9, claude), 0);
  // Every stop is the nearest to its own place; between two, the nearer, and the stronger of two as near.
  const places = pi.map((stop, index) => linePlace(index, pi));
  for (let index = 0; index < pi.length; index++) assert.equal(nearestPlace(places[index], places), index);
  assert.equal(nearestPlace(0.04, places), 0);
  assert.equal(nearestPlace(0.06, places), 1);
  assert.equal(nearestPlace(0.32, places), 1);
  assert.equal(nearestPlace(0.33, places), 2);
  assert.equal(nearestPlace(0.5, [0, 1]), 1);
  assert.equal(nearestPlace(-3, places), 0);
  assert.equal(nearestPlace(4, places), 3);
});

test("a release lands on the stop nearest where the gesture was heading", () => {
  const line = { width: 400, count: 5 }; // stops every 100 px
  // Let go still: the nearest stop.
  assert.equal(landingStop({ ...line, position: 140, velocity: 0 }), 1);
  assert.equal(landingStop({ ...line, position: 160, velocity: 0 }), 2);
  // A flick to the right carries it on (Apple's projection, rate 0.99: about a tenth of the velocity in px).
  assert.equal(Math.round(project(1000)), 99);
  assert.equal(landingStop({ ...line, position: 140, velocity: 1000 }), 2);
  assert.equal(landingStop({ ...line, position: 140, velocity: 3000 }), 4);
  assert.equal(landingStop({ ...line, position: 260, velocity: -1500 }), 1);
  // However hard the flick, it stays on the line.
  assert.equal(landingStop({ ...line, position: 380, velocity: 50_000 }), 4);
  assert.equal(landingStop({ ...line, position: 20, velocity: -50_000 }), 0);
  assert.equal(landingStop({ width: 0, count: 5, position: 0, velocity: 0 }), 0);
});

test("the thumb settles on a critically damped spring, and a flick's spring overshoots a little", () => {
  const settle = options => {
    let state = { x: 0, v: 0 }, peak = 0;
    for (let frame = 0; frame < 120; frame++) { state = springStep(state, 100, 1 / 60, options); peak = Math.max(peak, state.x); }
    return { ...state, peak };
  };
  const calm = settle({ response: 0.34, damping: 1 });
  assert.ok(Math.abs(calm.x - 100) < 0.5, "it arrives");
  assert.ok(calm.peak <= 100.01, "and never overshoots: " + calm.peak);
  const flick = settle({ response: 0.34, damping: 0.78 });
  assert.ok(flick.peak > 100.5 && flick.peak < 106, "a little bounce: " + flick.peak);
  // Handed the finger's velocity, it starts moving that way at once.
  assert.ok(springStep({ x: 50, v: 800 }, 100, 1 / 60).x > 50 + 800 / 60 * 0.8);
});

test("past either end the thumb is held back, more the further it goes", () => {
  assert.equal(rubberband(0), 0);
  assert.ok(rubberband(10) < 10 && rubberband(10) > 0);
  assert.ok(rubberband(100) < 28, "never further than the band allows");
  assert.ok(rubberband(40) > rubberband(20));
  assert.equal(rubberband(-30), -rubberband(30));
});

test("the sheet shows the slider for the level select, which stays in the page as its record", () => {
  const root = path.join(__dirname, "..");
  const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(index, /<div id="thinking-slider" class="effort-slider" role="slider" tabindex="0" aria-labelledby="thinking-label"/);
  assert.match(index, /<select id="thinking-select" class="effort-select" tabindex="-1" aria-hidden="true">/);
  assert.match(index, /modules\/effort-slider\.js\?v=[\d.]+"><\/script>[\s\S]*<script src="\/app\.js/);
  assert.match(fs.readFileSync(path.join(root, "public", "sw.js"), "utf8"), /"\/modules\/effort-slider\.js\?v=[\d.]+"/);
  assert.match(app, /stepsembleEffortSlider\?\.attach\(\{ select: el\.thinkingSelect, slider: \$\("thinking-slider"\)/);
});

test("the message box draws the level along its top edge as a slider of its own", () => {
  const root = path.join(__dirname, "..");
  const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  const toolbar = /<div class="composer-toolbar"[\s\S]*?<\/footer>/.exec(index)[0];
  // Right after the model button, whose own text is the model alone.
  assert.match(toolbar, /<button id="btn-model"[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>\s*(?:<!--[^>]*-->\s*)?<div id="composer-effort" class="composer-effort-line" role="slider"[^>]*aria-label="Thinking level"/);
  assert.doesNotMatch(toolbar, /composer-model-level|composer-effort-bar/, "no bars beside the model");
  for (const part of ["effort-line-track", "effort-line-fill", "effort-line-ticks", "effort-line-tip", "effort-line-label"]) assert.ok(toolbar.includes(`class="${part}"`), part);
  assert.match(app, /window\.stepsembleEffortSlider\?\.attachLine\?\.\(\{ slider: line, commit: commitEffortLevel \}\)/);
  // A finger's reach is 44px, a pointer's 24px; the chips above stay on top of it.
  assert.match(css, /#view-chat \.composer-effort-line \{\s*--line-out: 18px;\s*--line-in: 6px;/);
  assert.match(css, /@media \(pointer: coarse\) \{ #view-chat \.composer-effort-line \{ --line-out: 38px;/);
  assert.match(css, /#view-chat :is\(\.subagent-bar, \.task-progress\) \{ position: relative; z-index: 2; \}/);
  for (const query of ["prefers-reduced-motion: reduce", "prefers-contrast: more", "forced-colors: active", "prefers-reduced-transparency: reduce"]) {
    const at = css.indexOf("composer-effort-line {"), block = css.slice(at, css.indexOf("Context the agent has not reported yet", at));
    assert.ok(block.includes(query), query);
  }
});
