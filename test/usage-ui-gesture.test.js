"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../public/modules/usage-ui.js"), "utf8");
class Surface {
  constructor() { this.listeners = new Map(); this.dataset = { state: "open" }; this.style = {}; this.classList = { add() {}, remove() {} }; this.captures = new Set(); this.children = []; this.scrollTop = 0; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, fields = {}) { const event = { target: this, pointerId: 1, button: 0, clientY: 100, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...fields }; for (const fn of [...(this.listeners.get(type) || [])]) fn(event); return event; }
  count(type) { return this.listeners.get(type)?.size || 0; }
  getBoundingClientRect() { return { height: 400, bottom: 800, top: 0 }; }
  append() {} focus() {} contains(target) { return target === this; } querySelector() { return null; }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
}
function fixture() {
  const el = new Surface(), body = new Surface(), document = new Surface(), root = new Surface(), container = new Surface();
  document.documentElement = { classList: { contains: () => true } };
  el.children = [body]; let time = 0, dismissed = 0, sheet;
  const context = vm.createContext({ document, root, performance: { now: () => time }, getComputedStyle: () => ({ paddingBottom: "0" }),
    MutationObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: fn => fn(), clearTimeout() {}, setTimeout() {} });
  vm.runInContext(source.slice(source.indexOf("  const project ="), source.indexOf("  // openSettings,")) + "\nthis.glassSheet = glassSheet;", context);
  sheet = context.glassSheet(el, { container, area: new Surface(), top: () => 0, body, dismiss() { dismissed++; sheet.dismiss(); }, escape() {} });
  const header = { closest: selector => selector.startsWith("select") ? null : true };
  const down = (id = 1) => el.emit("pointerdown", { target: header, pointerId: id });
  const move = (y, id = 1) => { time += 16; document.emit("pointermove", { pointerId: id, clientY: y }); };
  const clean = () => { for (const type of ["pointermove", "pointerup", "pointercancel"]) assert.equal(document.count(type), 0, type); assert.equal(el.count("lostpointercapture"), 0); assert.equal(el.captures.size, 0); assert.equal(el.dataset.dragging, undefined); };
  return { el, body, document, root, sheet, down, move, clean, dismissed: () => dismissed };
}
test("usage-ui: only a header-origin pointer suppresses native sidebar DnD, including before capture", () => {
  const f = fixture(); assert.equal(f.document.emit("dragstart").defaultPrevented, undefined);
  f.down(); const stolen = f.document.emit("dragstart"); assert.equal(stolen.defaultPrevented, true); assert.equal(stolen.propagationStopped, true);
  f.move(104); assert.equal(f.el.dataset.dragging, undefined);
  f.document.emit("pointerup"); f.clean(); assert.equal(f.document.emit("dragstart").defaultPrevented, undefined);
});
test("usage-ui: mouse tracks 1:1, ignores other pointers and releases capture before dismiss", () => {
  const f = fixture(); f.down(); f.move(150, 2); assert.equal(f.el.dataset.dragging, undefined);
  f.move(150); assert.equal(f.el.style.transform, "translateY(50px)");
  f.document.emit("pointerup", { pointerId: 2 }); assert.equal(f.el.dataset.dragging, "true");
  f.move(410); f.document.emit("pointerup"); assert.equal(f.dismissed(), 1); f.clean();
});
test("usage-ui: reversing a drag returns the sheet without dismissing", () => {
  const f = fixture(); f.down(); f.move(250); f.move(100); f.document.emit("pointerup");
  assert.equal(f.dismissed(), 0); assert.equal(f.el.style.transform, ""); f.clean();
});
for (const end of ["pointercancel", "lostpointercapture", "dismiss", "blur"]) test(`usage-ui: ${end} clears listeners/capture; stale events cannot move the next gesture`, () => {
  const f = fixture(); f.down(); f.move(410);
  if (end === "dismiss") f.sheet.dismiss(); else if (end === "blur") f.root.emit("blur"); else (end === "lostpointercapture" ? f.el : f.document).emit(end);
  f.clean(); assert.equal(f.el.style.transform, ""); assert.equal(f.document.emit("dragstart").defaultPrevented, undefined);
  assert.equal(f.dismissed(), end === "blur" ? 1 : 0);
  f.document.emit("pointermove", { clientY: 800 }); assert.equal(f.el.style.transform, "");
  if (!["dismiss", "blur"].includes(end)) { f.down(2); f.move(150, 1); assert.equal(f.el.dataset.dragging, undefined); f.move(120, 2); assert.equal(f.el.style.transform, "translateY(20px)"); f.document.emit("pointercancel", { pointerId: 2 }); f.clean(); }
});
test("usage-ui: touch body pulls track 1:1, cancel returns, release dismisses; scrolled content stays native", () => {
  const f = fixture(), touches = y => ({ touches: [{ clientY: y }] });
  f.body.emit("touchstart", touches(100)); const move = f.body.emit("touchmove", touches(150));
  assert.equal(move.defaultPrevented, true); assert.equal(f.el.style.transform, "translateY(50px)");
  f.body.emit("touchcancel"); assert.equal(f.dismissed(), 0); assert.equal(f.el.style.transform, "");
  f.body.scrollTop = 10; f.body.emit("touchstart", touches(100)); assert.equal(f.body.emit("touchmove", touches(150)).defaultPrevented, undefined);
  f.body.scrollTop = 0; f.body.emit("touchstart", touches(100)); f.body.emit("touchmove", touches(410)); f.body.emit("touchend"); assert.equal(f.dismissed(), 1); f.clean();
});
