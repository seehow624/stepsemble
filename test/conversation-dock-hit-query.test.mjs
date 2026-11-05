import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileFunction, createContext } from "node:vm";

const fixture = JSON.parse(await readFile(new URL("../test-support/conversation-dock-hit-fixtures.json", import.meta.url), "utf8"));
const source = await readFile(new URL("../scripts/conversation-ux-browser-cases.mjs", import.meta.url), "utf8");

function reachCallback(text) {
  text = text.replace(/\r\n/g, "\n");
  const marker = "const reach = await codex.evaluate(";
  const start = text.indexOf(marker) + marker.length;
  const end = text.indexOf("\n      });\n      assert.ok(reach.free", start);
  assert.ok(start >= marker.length && end > start, "read the actual dock callback");
  return text.slice(start, end) + "\n      }";
}

function rectangle([left, top, right, bottom]) {
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

// Minimal DOM interfaces only. Responses are frozen observations, never geometry predictions.
function frozenDOM(cell, overrides = new Map()) {
  const nodes = Object.fromEntries(Object.entries(cell.geometry).map(([id, shape]) => [id, {
    id, localName: ["nativeButton", "goalButton", "bubble"].includes(id) ? "button" : "div", classList: [], parentElement: null,
    getBoundingClientRect: () => rectangle(shape.rect),
    contains(hit) { for (let node = hit; node; node = node.parentElement) if (node === this) return true; return false; },
    style: { display: "block", visibility: "visible", pointerEvents: shape.pointerEvents, transform: "none", borderRadius: shape.borderRadius,
      position: "static", overflowX: "visible", overflowY: "visible",
      ...Object.fromEntries(["Top", "Right", "Bottom", "Left"].map(side => ["border" + side + "Width", "0px"])),
      ...Object.fromEntries(["TopLeft", "TopRight", "BottomRight", "BottomLeft"].map(corner => ["border" + corner + "Radius", shape.borderRadius])) },
  }]));
  for (const [id, parent] of Object.entries({ native: "bar", goal: "bar", bubble: "bar", nativeButton: "native", goalButton: "goal", bar: "background", composer: "background", line: "composer" })) nodes[id].parentElement = nodes[parent];
  for (const node of Object.values(nodes)) node.querySelectorAll = function(selector) {
    assert.equal(selector, "button");
    return Object.values(nodes).filter(child => child !== this && child.localName === "button" && this.contains(child));
  };
  const chips = [nodes.native, nodes.goal, nodes.bubble], calls = [];
  const hits = new Map(cell.samples.filter(p => p[1] === "original").map(p => [`${p[2]},${p[3]}`, p[5]]));
  const foreign = { ...nodes.background, id: "foreign", parentElement: null };
  const hitAt = (x, y) => {
    const key = `${x},${y}`;
    assert.ok(hits.has(key), "no fabricated hit at " + key);
    const id = overrides.has(key) ? overrides.get(key) : hits.get(key);
    return id === null ? null : id === "foreign" ? foreign : nodes[id];
  };
  const globals = { document: {
    querySelector: selector => selector === "#composer-effort" ? nodes.line : selector === "#subagent-bar" ? nodes.bar : assert.fail(selector),
    querySelectorAll: selector => selector === "#subagent-bar > *" ? chips : assert.fail(selector),
    elementFromPoint: (x, y) => { calls.push([x, y]); return hitAt(x, y); },
    elementsFromPoint: (x, y) => { const hit = hitAt(x, y); return hit ? [hit] : []; },
  }, getComputedStyle: (node, pseudo) => pseudo ? node.pseudos?.[pseudo] || { ...node.style, content: "none" } : node.style,
  innerWidth: 1084, innerHeight: 828, devicePixelRatio: cell.dpr, matchMedia: () => ({ matches: false }) };
  return { nodes, chips, calls, globals };
}

function evaluateReach(cell, overrides, configure = () => {}) {
  const dom = frozenDOM(cell, overrides);
  configure(dom);
  const result = compileFunction(`return (${reachCallback(source)})();`, [], { parsingContext: createContext(dom.globals) })();
  return { result, dom };
}

function predicateSource(text) {
  const callback = reachCallback(text), start = callback.indexOf("function dockHitQueryIntersects(");
  const end = callback.indexOf("\n        const line =", start);
  assert.ok(start >= 0 && end > start);
  return callback.slice(start, end);
}
const intersects = compileFunction(`${predicateSource(source)}; return dockHitQueryIntersects;`)();
const guardStart = source.indexOf("      assert.ok(reach.free > 0");
const guardEnd = source.indexOf("\n      await toggle.click()", guardStart);
assert.ok(guardStart >= 0 && guardEnd > guardStart);
const assertReach = compileFunction(source.slice(guardStart, guardEnd), ["reach", "viewport", "assert"]);
const accepted = result => assertReach(result, { width: 1440 }, assert);

test("recorded original lattice keeps strict reach equality in the actual callback", () => {
  for (const cell of fixture.cells) {
    const { result, dom } = evaluateReach(cell);
    accepted(result);
    assert.equal(result.free, 41); assert.equal(result.line, 41);
    assert.equal(result.total, 134); assert.equal(result.chipOwned, 93); assert.equal(result.chipMatched, 93);
    assert.equal(result.ambiguous, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(result.chipOwners)).map(p => [p.expected, p.matched]), [[38, 38], [29, 29], [26, 26]]);
    assert.deepEqual(dom.calls, cell.samples.filter(p => p[1] === "original").map(p => [p[2], p[3]]), "query EVERY original point once, including chip-owned points");
    assert.equal(result.diagnostics, undefined);
    console.log(JSON.stringify({ engine: cell.engine, dpr: cell.dpr, total: result.total, free: result.free, line: result.line, chipOwned: result.chipOwned, chipMatched: result.chipMatched }));
  }
});

test("shared runtime CSS predicate matches all 844 saved top-level owners, including all edge controls", () => {
  assert.equal(fixture.cells.length, 4);
  let comparisons = 0;
  for (const cell of fixture.cells) {
    assert.equal(cell.samples.length, 211); assert.equal(new Set(cell.samples.map(p => p[0])).size, 211);
    assert.deepEqual(cell.samples.filter(p => p[1] === "original").map(p => [p[2], p[3]]), Array.from({ length: 134 }, (_, i) => [141 + i * 6, 690]));
    for (const name of ["recordFileSha256", "sourceSha256", "fixtureSha256"]) assert.match(cell[name], /^[a-f0-9]{64}$/);
    const { nodes } = frozenDOM(cell);
    for (const [id, , x, y, observedOwner, observedTarget] of cell.samples) {
      // Only paint order is supplied here. Geometry uses the ACTUAL callback's
      // predicate, not the rejected DPR model or recorded hit-selected bounds.
      const owner = ["bubble", "goal", "native", "line", "composer", "background"].find(name => intersects(nodes[name].getBoundingClientRect(), nodes[name].style, x, y)) || "unknown";
      assert.equal(owner, observedOwner, `${cell.engine}/${cell.dpr}/${id}`);
      assert.equal(({ nativeButton: "native", goalButton: "goal" })[observedTarget] || observedTarget, observedOwner);
      comparisons++;
    }
  }
  assert.equal(comparisons, 844);
  console.log(JSON.stringify({ savedTopLevelOwnerComparisons: comparisons, exactSubtargetPortabilityClaim: false }));
});

test("actual guard rejects wrong line, other chip, overlay and null at chip-owned AND free points", () => {
  const cell = fixture.cells[0];
  for (const [x, wrong] of [[141, "line"], [141, "goalButton"], [141, "foreign"], [141, null], [375, "nativeButton"], [741, "nativeButton"], [741, "foreign"], [741, null]]) {
    const { result, dom } = evaluateReach(cell, new Map([[`${x},690`, wrong]]));
    assert.throws(() => accepted(result), { name: "AssertionError" });
    assert.equal(dom.calls.length, 134);
    assert.equal(result.total, result.free + result.chipOwned);
    assert.equal(result.diagnostics.misses.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(result.diagnostics.misses[0].expectedOwners)), [x === 741 ? "thinking-line" : x === 375 ? "chip-1" : "chip-0"]);
  }
});

test("actual callback retains bounded positive-owner diagnostics and rejects ambiguity", () => {
  const cell = fixture.cells[0];
  const overrides = new Map(Array.from({ length: 6 }, (_, i) => [`${141 + i * 6},690`, "foreign"]));
  const { result } = evaluateReach(cell, overrides);
  assert.throws(() => accepted(result), { name: "AssertionError" });
  assert.equal(result.diagnostics.misses.length, 4); assert.equal(result.diagnostics.missesTruncated, true);
  const ambiguous = evaluateReach(cell, undefined, dom => {
    dom.nodes.goal.getBoundingClientRect = dom.nodes.native.getBoundingClientRect;
  });
  assert.ok(ambiguous.result.ambiguous > 0);
  assert.throws(() => accepted(ambiguous.result), { name: "AssertionError" });
  assert.equal(ambiguous.dom.calls.length, 134);
});

test("hidden and zero-area panels cannot own samples; rectangular groups own rounded descendants", () => {
  const cell = fixture.cells[0];
  const { result } = evaluateReach(cell, undefined, dom => {
    const shape = dom.nodes.native;
    for (const style of [{ display: "none" }, { visibility: "hidden" }, { pointerEvents: "none" }]) dom.chips.push({ ...shape, style: { ...shape.style, ...style } });
    dom.chips.push({ ...shape, getBoundingClientRect: () => rectangle([141, 680, 141, 701]) });
    dom.chips.push({ ...shape, getBoundingClientRect: () => rectangle([141, 690, 200, 690]) });
  });
  accepted(result); assert.equal(result.chipOwned, 93);
  const { nodes } = frozenDOM(cell);
  const x = 375.578125, y = 671.421875;
  assert.equal(intersects(nodes.goal.getBoundingClientRect(), nodes.goal.style, x, y), true);
  assert.equal(intersects(nodes.goalButton.getBoundingClientRect(), nodes.goalButton.style, x, y), false);
  assert.equal(nodes.goal.contains(nodes.goalButton), true);
});

test("CSS one-pixel query has fractional boundaries, real rounded corners and genuinely free gaps", () => {
  const { nodes } = frozenDOM(fixture.cells[0]);
  const goal = nodes.goal;
  assert.equal(intersects(goal.getBoundingClientRect(), goal.style, 374, 690), false);
  assert.equal(intersects(goal.getBoundingClientRect(), goal.style, 375, 690), true);
  assert.equal(intersects(goal.getBoundingClientRect(), goal.style, 376, 690), true);
  assert.ok([371, 550, 741].every(x => ["native", "goal", "bubble"].every(id => !intersects(nodes[id].getBoundingClientRect(), nodes[id].style, x, 690))));
  const pill = rectangle([0, 0, 100, 20]), style = nodes.bubble.style;
  assert.equal(intersects(pill, style, 0, 0), false);
  assert.equal(intersects(pill, style, 5, 5), true);
  assert.equal(intersects(pill, style, -0.5, 10), true);
  assert.equal(intersects(pill, style, -1, 10), false);
  assert.equal(intersects(rectangle([0, 0, 0, 20]), style, 0, 0), false);
  // Held-out 2b macOS failure geometry only: 40/39 remains failed. This is
  // not a saved full hit vector or a claim of repaired actual-app acceptance.
  const heldOutGoal = rectangle([381.90625, 671.171875, 555.84375, 701]);
  assert.equal(381 >= heldOutGoal.left, false);
  assert.equal(intersects(heldOutGoal, goal.style, 381, 690), true);
});

test("dock actual callback and predicate source readers are equivalent for LF and CRLF", () => {
  const lf = source.replace(/\r\n/g, "\n"), crlf = lf.replace(/\n/g, "\r\n");
  assert.equal(reachCallback(lf), reachCallback(crlf));
  assert.equal(predicateSource(lf), predicateSource(crlf));
  const callback = reachCallback(source);
  assert.ok(callback.indexOf("samples.push({ x, owners })") < callback.indexOf("document.elementFromPoint"));
  assert.match(callback, /for \(let x = box.left \+ 8; x < box.right - 8; x \+= 6\)/);
  assert.doesNotMatch(predicateSource(source), /devicePixelRatio|userAgent|document\.elementFromPoint|epsilon|tolerance/);
});

// Explicitly SYNTHETIC controls of the existing coarse-pointer CSS, not saved
// mobile observations. A 36px host with 1px borders has an inset:-5px 0
// generated rectangle at [1,16,154.921875,60], measured from its padding box.
// The hit vectors below are fixed controls; they never call the tested predicate.
function syntheticGeneratedCase(target, sampleY, active = true) {
  const cell = JSON.parse(JSON.stringify(fixture.cells[0]));
  const owner = ({ nativeButton: "native", goalButton: "goal" })[target] || target;
  for (const name of ["native", "goal", "bubble", "nativeButton", "goalButton"]) cell.geometry[name].rect = [0, 0, 0, 0];
  cell.geometry[owner].rect = [0, 20, 155.921875, 56];
  cell.geometry[target].rect = [0, 20, 155.921875, 56];
  cell.geometry.line.rect = [1, sampleY - 2, 169, sampleY + 22];
  cell.samples = Array.from({ length: 26 }, (_, i) => {
    const x = 9 + i * 6;
    const owned = active ? x <= 153 : sampleY === 25 && x <= 147;
    return ["synthetic-" + i, "original", x, sampleY, owned ? owner : "line", owned ? target : "line"];
  });
  return { cell, configure(dom) {
    dom.globals.innerWidth = 393; dom.globals.innerHeight = 852;
    dom.globals.matchMedia = () => ({ matches: true });
    Object.assign(dom.nodes[target].style, { position: "relative",
      ...Object.fromEntries(["Top", "Right", "Bottom", "Left"].map(side => ["border" + side + "Width", "1px"])) });
    dom.nodes[target].pseudos = { "::after": { ...dom.nodes.line.style,
      content: active ? '""' : "none", position: "absolute", top: "-5px", right: "0px", bottom: "-5px", left: "0px",
      marginTop: "0px", marginRight: "0px", marginBottom: "0px", marginLeft: "0px" } };
  } };
}

test("synthetic coarse-pointer direct generated corner and extension keep the original strict guard", () => {
  for (const y of [25, 17]) {
    const control = syntheticGeneratedCase("bubble", y);
    const { result, dom } = evaluateReach(control.cell, undefined, control.configure);
    accepted(result);
    assert.equal(result.total, 26); assert.equal(result.free, 1); assert.equal(result.line, 1);
    assert.equal(result.chipOwned, 25); assert.equal(result.chipMatched, 25);
    assert.deepEqual(dom.calls, control.cell.samples.map(p => [p[2], p[3]]));
  }
});

test("synthetic coarse-pointer descendant generated extension belongs to its specific group", () => {
  for (const target of ["nativeButton", "goalButton"]) {
    const control = syntheticGeneratedCase(target, 17);
    const { result, dom } = evaluateReach(control.cell, undefined, control.configure);
    accepted(result);
    assert.equal(result.total, 26); assert.equal(result.free, 1); assert.equal(result.line, 1);
    assert.equal(result.chipOwned, 25); assert.equal(result.chipMatched, 25);
    assert.deepEqual(dom.calls, control.cell.samples.map(p => [p[2], p[3]]));
  }
});

test("generated padding-box regions respect host border offsets and the existing inset-only CSS", async () => {
  const css = await readFile(new URL("../public/style.css", import.meta.url), "utf8");
  const selector = "#view-chat :is(.goal-chip, .goal-chip-close, .subagent-bubble, .native-run-toggle, .native-run-dismiss)::after {";
  const start = css.indexOf(selector), end = css.indexOf("}", start);
  assert.ok(start >= 0 && end > start);
  assert.deepEqual(css.slice(start + selector.length, end).replace(/\s/g, "").split(";").filter(Boolean),
    ['content:""', "position:absolute", "inset:-5px0"], "the supported generated target stays inset-only, not a general CSS renderer");
  for (const side of ["left", "right", "top", "bottom"]) {
    const control = syntheticGeneratedCase("bubble", side === "top" ? 15 : side === "bottom" ? 60 : 17);
    if (side === "left" || side === "right") {
      const xs = side === "left" ? [0, 6, 12, 18] : [155, 161, 167];
      control.cell.geometry.line.rect = side === "left" ? [-8, 15, 28, 39] : [147, 15, 181, 39];
      control.cell.samples = xs.map((x, i) => ["synthetic-border-" + i, "original", x, 17,
        side === "left" && x > 0 ? "bubble" : "line", side === "left" && x > 0 ? "bubble" : "line"]);
    } else control.cell.samples = control.cell.samples.map(p => [p[0], p[1], p[2], p[3], "line", "line"]);
    const { result, dom } = evaluateReach(control.cell, undefined, control.configure);
    accepted(result);
    assert.equal(result.free, side === "left" ? 1 : control.cell.samples.length);
    assert.deepEqual(dom.calls, control.cell.samples.map(p => [p[2], p[3]]));
  }
});

test("inactive generated regions never claim rounded holes or outside extensions", () => {
  for (const y of [25, 17]) {
    for (const disabled of [{ content: "none" }, { content: "normal" }, { display: "none" }, { visibility: "hidden" }, { pointerEvents: "none" }]) {
      const control = syntheticGeneratedCase("bubble", y, false);
      const { result, dom } = evaluateReach(control.cell, undefined, dom => {
        control.configure(dom);
        Object.assign(dom.nodes.bubble.pseudos["::after"], { content: '""', ...disabled });
      });
      accepted(result);
      assert.equal(result.free, y === 25 ? 2 : 26);
      assert.equal(result.line, result.free);
      assert.equal(dom.calls.length, 26);
    }
  }
});

test("generated-only samples reject wrong owners and fail closed on unsupported active CSS", () => {
  for (const target of ["bubble", "nativeButton", "goalButton"]) {
    const control = syntheticGeneratedCase(target, 17);
    const other = target === "nativeButton" ? "goalButton" : "nativeButton";
    for (const wrong of ["line", other, "foreign", null]) {
      const { result, dom } = evaluateReach(control.cell, new Map([["153,17", wrong]]), control.configure);
      assert.throws(() => accepted(result), { name: "AssertionError" });
      assert.equal(result.chipOwned, 25); assert.equal(result.chipMatched, 24);
      assert.equal(dom.calls.length, 26);
    }
  }
  for (const unsupported of [{ position: "fixed" }, { transform: "matrix(1, 0, 0, 1, 1, 0)" }, { marginTop: "1px" }, { top: "-5%" }]) {
    const control = syntheticGeneratedCase("bubble", 17);
    assert.throws(() => evaluateReach(control.cell, undefined, dom => {
      control.configure(dom); Object.assign(dom.nodes.bubble.pseudos["::after"], unsupported);
    }), { name: "Error", message: "Unsupported dock generated hit-region CSS" });
  }
  for (const which of ["host", "ancestor"]) {
    const control = syntheticGeneratedCase("nativeButton", 17);
    assert.throws(() => evaluateReach(control.cell, undefined, dom => {
      control.configure(dom); dom.nodes[which === "host" ? "nativeButton" : "native"].style.overflowX = "hidden";
    }), { name: "Error", message: "Unsupported dock generated hit-region CSS" });
  }
});
