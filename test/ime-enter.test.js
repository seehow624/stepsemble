"use strict";
// An input method (Chinese, Japanese, Korean, or English typed through one)
// confirms its text with Enter. That Enter is the input method's: no text
// field may send, save or run anything on it. Every field reads the key
// through stepsembleComposerIme.isEnter (public/modules/composer-ime.js),
// which also catches WebKit's late keydown (keyCode 229 after
// compositionend), as the Mac app and Safari send it.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const root = path.join(__dirname, "..", "public");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

function files(dir = root) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "vendor" ? [] : files(full);
    return /\.(js|html)$/.test(entry.name) ? [path.relative(root, full)] : [];
  });
}

test("no page code reads the Enter key except through isEnter, so an input method's Enter never acts", () => {
  const found = [];
  for (const file of files()) {
    if (file === path.join("modules", "composer-ime.js")) continue;
    read(file).split("\n").forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, "");
      if (!/["']Enter["']|["']NumpadEnter["']|(?:keyCode|which|charCode)\s*===?\s*13\b/.test(code)) return;
      // A button, link or chart column answers Enter and Space alike; it
      // takes no text, so no input method types into it.
      if (/["'] ["']/.test(code)) return;
      found.push(`${file}:${index + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(found, [], "read Enter in a text field with isEnter(event):\n" + found.join("\n"));
});

test("every page whose code reads Enter loads the shared check first", () => {
  for (const [page, users] of [["index.html", ["app.js"]], ["workspace.html", ["modules/workspace.js"]], ["assistant.html", ["modules/assistant.js", "modules/assistant-groups.js"]]]) {
    const html = read(page), shared = html.indexOf("/modules/composer-ime.js?v=");
    assert.ok(shared > -1, `${page} loads composer-ime.js`);
    for (const user of users) {
      assert.match(read(user), /stepsembleComposerIme\?\.isEnter\(event\)/, `${user} reads Enter through the shared check`);
      const at = html.indexOf(`/${user}?v=`);
      assert.ok(at > shared, `${page} loads composer-ime.js before ${user}`);
    }
  }
  assert.match(read("sw.js"), /"\/modules\/composer-ime\.js\?v=/, "it is cached for offline use");
});

// The module as a page runs it: its listeners on a document of its own.
function page() {
  const listeners = {};
  const document = { addEventListener(type, fn, capture) { assert.equal(capture, true, "captured, before any field's own handler"); (listeners[type] ||= []).push(fn); } };
  const window = { document };
  vm.runInNewContext(read("modules/composer-ime.js"), { window });
  const fire = type => (listeners[type] || []).forEach(fn => fn({ type }));
  return { ime: window.stepsembleComposerIme, fire };
}
const key = (fields = {}) => ({ key: "Enter", keyCode: 13, which: 13, isComposing: false, ...fields });

test("Enter acts; the Enter an input method confirms text with does not, in Chrome and in WebKit", () => {
  const { ime, fire } = page();
  assert.equal(ime.isEnter(key()), true, "a plain Enter");
  assert.equal(ime.isEnter(key({ key: "a", keyCode: 65 })), false);
  assert.equal(ime.isEnter(null), false);
  // Chrome and current Safari: the confirming keydown is marked as composing.
  assert.equal(ime.isEnter(key({ isComposing: true, keyCode: 229 })), false);
  // WebKit bug 165004: it arrives after compositionend, marked only by 229.
  fire("compositionstart"); fire("compositionend");
  assert.equal(ime.isEnter(key({ keyCode: 229, which: 229 })), false);
  assert.equal(ime.isImeEnter(key({ keyCode: 229, which: 229 })), true);
  // While a composition is open, even an Enter that looks plain is its.
  fire("compositionstart");
  assert.equal(ime.isEnter(key()), false);
  fire("compositionend");
  assert.equal(ime.isEnter(key()), true, "the next Enter after the text is confirmed sends");
  // Leaving the field mid-composition does not hold the next field's Enter.
  fire("compositionstart"); fire("focusout");
  assert.equal(ime.isEnter(key()), true);
});

test("the Bot's message box draws no ring inside its capsule", () => {
  const css = read("modules/assistant.css");
  assert.match(css, /\.assistant-input:is\(:focus, :focus-visible\) \{ outline: 0; box-shadow: none; \}/);
  assert.match(css, /\.assistant-composer-field:focus-within \{ border-color:/, "the capsule shows the focus");
});
