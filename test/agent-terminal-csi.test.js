"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const terminal = require("../public/modules/agent-terminal");

const terminalSource = fs.readFileSync(path.join(__dirname, "../public/modules/agent-terminal.js"), "utf8");

function runInTerminalVm(body, timeout = 1000) {
  vm.runInNewContext(`${terminalSource}\n${body}`, { module: { exports: {} } }, { timeout });
}

test("CSI line and character operations preserve defaults, zero, values and leading zeroes", () => {
  function snapshot(operation, parameter) {
    const screen = terminal.createScreen({ cols: 4, rows: 4 });
    screen.write("AAAA\r\nBBBB\r\nCCCC\r\nDDDD");
    screen.write("\x1b[2;4r");
    if (operation === "L" || operation === "M") screen.write("\x1b[3;1H");
    if (operation === "@" || operation === "P" || operation === "X") screen.write("\x1b[1;2H");
    screen.write(`\x1b[${parameter}${operation}`);
    return JSON.stringify({ rows: screen.textRows({ includeHistory: false }), cursor: screen.cursor });
  }

  for (const operation of ["S", "T", "L", "M", "@", "P", "X"]) {
    const one = snapshot(operation, "1");
    assert.equal(snapshot(operation, ""), one, `${operation}: omitted count defaults to one`);
    assert.equal(snapshot(operation, "0"), one, `${operation}: zero count defaults to one`);
    assert.equal(snapshot(operation, "0001"), one, `${operation}: leading zeroes are decimal`);
    assert.equal(snapshot(operation, "0002"), snapshot(operation, "2"), `${operation}: leading zeroes preserve a normal count`);
  }
});

test("CSI cursor addressing uses one-based defaults and clamps to the screen", () => {
  const screen = terminal.createScreen({ cols: 8, rows: 3 });
  screen.write("\x1b[H");
  assert.deepEqual(screen.cursor, { x: 0, y: 0, visible: true });
  screen.write("\x1b[0;0H");
  assert.deepEqual(screen.cursor, { x: 0, y: 0, visible: true });
  screen.write("\x1b[0002;0003H");
  assert.deepEqual(screen.cursor, { x: 2, y: 1, visible: true });

  screen.write("\x1b[999999999999;999999999999H");
  assert.deepEqual(screen.cursor, { x: 7, y: 2, visible: true });
  screen.write("\x1b[999999999999B\x1b[999999999999C");
  assert.deepEqual(screen.cursor, { x: 7, y: 2, visible: true });
  screen.write("\x1b[999999999999A\x1b[999999999999D");
  assert.deepEqual(screen.cursor, { x: 0, y: 0, visible: true });
  screen.write("\x1b[999999999999E");
  assert.deepEqual(screen.cursor, { x: 0, y: 2, visible: true });
  screen.write("\x1b[999999999999F");
  assert.deepEqual(screen.cursor, { x: 0, y: 0, visible: true });
  screen.write("\x1b[999999999999G\x1b[999999999999d");
  assert.deepEqual(screen.cursor, { x: 7, y: 2, visible: true });
});

test("ordinary CSI colours and private screen modes still work", () => {
  const screen = terminal.createScreen({ cols: 8, rows: 3 });
  screen.write("\x1b[38;2;12;34;56mR\x1b[0m\x1b[48;5;196mB");
  const runs = screen.styledRows()[0];
  assert.equal(runs[0].text, "R");
  assert.equal(runs[0].attr.fg, "rgb(12,34,56)");
  assert.equal(runs[1].text, "B");
  assert.equal(runs[1].attr.bg, "rgb(255,0,0)");
  screen.write("\x1b[?25l\x1b[?1049h");
  assert.equal(screen.cursor.visible, false);
  assert.equal(screen.alternate, true);
  screen.write("\x1b[?1049l\x1b[?25h");
  assert.equal(screen.cursor.visible, true);
  assert.equal(screen.alternate, false);
  assert.equal(screen.textRows()[0], "RB");
});

test("very large CSI counts are capped by screen and scroll-region dimensions", () => {
  const sixtyFourDigits = "9".repeat(64);
  const body = `
    const createScreen = module.exports.createScreen;
    const largeCounts = ["999999999999", ${JSON.stringify(sixtyFourDigits)}];
    function same(actual, expected, label) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(label + ": expected " + JSON.stringify(expected) + ", received " + JSON.stringify(actual));
      }
    }
    function visible(screen) {
      return { rows: screen.textRows({ includeHistory: false }), cursor: screen.cursor };
    }
    function lineOperation(operation, count) {
      const screen = createScreen({ cols: 4, rows: 5, scrollback: 20 });
      screen.write("AAAA\\r\\nBBBB\\r\\nCCCC\\r\\nDDDD\\r\\nEEEE");
      screen.write("\\x1b[2;4r");
      if (operation === "L" || operation === "M") screen.write("\\x1b[3;1H");
      screen.write("\\x1b[" + count + operation);
      return visible(screen);
    }
    function cellOperation(operation, count) {
      const screen = createScreen({ cols: 5, rows: 2 });
      screen.write("ABCDE\\x1b[1;2H");
      screen.write("\\x1b[" + count + operation);
      return visible(screen);
    }
    for (const count of largeCounts) {
      for (const operation of ["S", "T"]) same(lineOperation(operation, count), lineOperation(operation, "3"), operation + " scroll-region cap");
      for (const operation of ["L", "M"]) same(lineOperation(operation, count), lineOperation(operation, "3"), operation + " line cap");
      for (const operation of ["@", "P", "X"]) same(cellOperation(operation, count), cellOperation(operation, "4"), operation + " screen-width cap");

      const cursor = createScreen({ cols: 5, rows: 3 });
      // Each sequence fits the 64-byte parameter budget. Two 64-digit
      // coordinates in one H command would correctly discard the whole CSI.
      cursor.write("\\x1b[" + count + "G\\x1b[" + count + "d");
      same(cursor.cursor, { x: 4, y: 2, visible: true }, "cursor clamp");
    }
  `;
  // The VM timeout interrupts a parser regression that loops over the untrusted count.
  runInTerminalVm(body, 1000);
});

test("CSI parameters longer than 64 characters are discarded through their final byte, across chunks", () => {
  for (const chunks of [["9".repeat(65)], ["9".repeat(32), "9".repeat(33)]]) {
    const screen = terminal.createScreen({ cols: 20, rows: 2 });
    screen.write("A\x1b[");
    for (const chunk of chunks) screen.write(chunk);
    screen.write("CZ");
    assert.equal(screen.textRows()[0], "AZ");
    assert.deepEqual(screen.cursor, { x: 2, y: 0, visible: true });
  }
  runInTerminalVm(`
    const screen = module.exports.createScreen({ cols: 20, rows: 2 });
    screen.write("A\\x1b[" + "9".repeat(100000));
    screen.write("SZ");
    if (screen.textRows()[0] !== "AZ") throw new Error("oversized CSI leaked text or scrolled");
  `);
});

test("a fresh ESC restarts CSI parsing, while CAN and SUB cancel the pending sequence", () => {
  for (const pending of ["9", "9".repeat(65)]) {
    const restarted = terminal.createScreen({ cols: 20, rows: 2 });
    restarted.write("A\x1b[" + pending);
    restarted.write("\x1b[2CZ");
    assert.equal(restarted.textRows()[0], "A  Z");
    assert.deepEqual(restarted.cursor, { x: 4, y: 0, visible: true });

    for (const cancel of ["\x18", "\x1a"]) {
      const screen = terminal.createScreen({ cols: 20, rows: 2 });
      screen.write("A\x1b[" + pending);
      screen.write(cancel + "Z");
      assert.equal(screen.textRows()[0], "AZ", cancel === "\x18" ? "CAN cancels CSI" : "SUB cancels CSI");
      assert.deepEqual(screen.cursor, { x: 2, y: 0, visible: true });
    }
  }
});

test("malformed signed or fractional CSI parameters do not move the cursor", () => {
  for (const parameter of ["-5", "+2", "1.5", "2-1", ".5"]) {
    const screen = terminal.createScreen({ cols: 12, rows: 2 });
    screen.write("AB\x1b[" + parameter + "CX");
    assert.equal(screen.textRows()[0], "ABX", parameter);
    assert.deepEqual(screen.cursor, { x: 3, y: 0, visible: true }, parameter);
  }
});

test("combining marks stay zero-width and attach to the character at the right edge", () => {
  const marks = terminal.createScreen({ cols: 4, rows: 2 });
  marks.write("a\u0300\u036f");
  assert.equal(marks.textRows()[0], "a\u0300\u036f");
  assert.deepEqual(marks.cursor, { x: 1, y: 0, visible: true });

  const edge = terminal.createScreen({ cols: 3, rows: 2 });
  edge.write("abc\u0301");
  assert.equal(edge.textRows()[0], "abc\u0301");
  assert.deepEqual(edge.cursor, { x: 2, y: 0, visible: true });
  edge.write("X");
  assert.deepEqual(edge.textRows(), ["abc\u0301", "X"], "combining does not cancel pending wrap");

  const wide = terminal.createScreen({ cols: 3, rows: 2 });
  wide.write("a中\u0301X");
  assert.deepEqual(wide.textRows(), ["a中\u0301", "X"], "the mark attaches to the wide character, not its continuation cell");
  assert.equal(terminal.charWidth(0x0300), 0);
  assert.equal(terminal.charWidth(0x036f), 0);
});
