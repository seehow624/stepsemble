"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const identity = require("../public/modules/agent-identity.js");
const root = path.resolve(__dirname, "../public");
const read = name => fs.readFileSync(path.join(root, name), "utf8");
const ids = ["pi", "claude-code", "codex", "opencode", "grok-build", "antigravity", "cline", "kilo", "hermes", "omp", "gpt", "chatgpt"];
test("every installed harness definition has an explicit mark", () => {
  const source = fs.readFileSync(path.join(__dirname, "../server/agent-connectors.js"), "utf8");
  const definitions = source.slice(source.indexOf("const CONNECTOR_DEFINITIONS"), source.indexOf("function safeConnectorId"));
  const nativeIds = [...definitions.matchAll(/id: "([a-z-]+)"/g)].map(match => match[1]);
  assert.equal(nativeIds.length, 10);
  for (const id of nativeIds) assert.equal(identity.lookup(id).id, id);
});
test("canonical source IDs map independently of selected models", () => {
  for (const id of ids) {
    assert.equal(identity.lookup(id).id, id);
    assert.equal(identity.lookup(` ${id.toUpperCase()} `).id, id);
    assert.ok(Object.isFrozen(identity.lookup(id)));
  }
  for (const value of [undefined, null, {}, [], 0, "", "__proto__", "constructor", "toString", "gpt-5", "claude-sonnet-4", "https://example.com/logo.svg", "x".repeat(33), { toString() { throw Error("coerced"); } }]) {
    assert.equal(identity.lookup(value).id, "agent");
  }
  assert.notEqual(identity.lookup("codex").id, identity.lookup("gpt").id);
});
function doc() {
  return { createElement(tag) { return { tag, dataset: {}, attrs: {}, children: [],
    setAttribute(key, value) { this.attrs[key] = value; }, appendChild(child) { this.children.push(child); } }; } };
}
test("badge keeps branding accessible without HTML, URLs or duplicate narration", () => {
  for (const id of ids) {
    const badge = identity.create(doc(), id);
    assert.equal(badge.dataset.agentId, id);
    assert.equal(badge.attrs.role, "img");
    assert.equal(badge.attrs["aria-label"], identity.lookup(id).label);
    assert.equal(badge.children[0].attrs["aria-hidden"], "true");
    assert.equal(badge.innerHTML, undefined);
    const decorative = identity.create(doc(), id, true);
    assert.equal(decorative.attrs["aria-hidden"], "true");
    assert.equal(decorative.attrs.role, undefined);
  }
  assert.equal(identity.create(doc(), '<img onerror="evil">').dataset.agentId, "agent");
});
test("every badge uses only inert, local, offline-cached SVG assets", () => {
  const css = read("modules/agent-identity.css"), worker = read("sw.js");
  for (const id of [...ids, "agent"]) assert.ok(css.includes(`[data-agent-id="${id}"]`));
  const assets = [...new Set([...css.matchAll(/url\("([^"]+)"\)/g)].map(match => match[1]))];
  assert.equal(assets.length, 12);
  for (const asset of assets) {
    assert.match(asset, /^\/agent-logos\/v2\/[a-z-]+\.svg$/);
    const svg = read(asset.slice(1));
    assert.match(svg, /<svg\b/);
    // A colour mark may point at its own gradient, mask or filter (url(#id)),
    // never at anything outside the file.
    assert.doesNotMatch(svg, /<(?:script|foreignObject|image|use|a|style)\b|\son\w+=|(?:href|src)=|url\((?!#)/i);
    assert.ok(worker.includes(JSON.stringify(asset)), `${asset} must be cached`);
  }
  assert.notEqual(read("agent-logos/v2/codex.svg"), read("agent-logos/v2/openai.svg"));
  for (const file of ["modules/agent-identity.js", "modules/agent-identity.css"]) {
    assert.ok(worker.includes(`/${file}?v=`)); assert.ok(read("index.html").includes(`/${file}?v=`));
  }
});
test("a mark keeps its own colours in light and dark: the theme never tints it", () => {
  const css = read("modules/agent-identity.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const assets = [...new Set([...css.matchAll(/url\("([^"]+)"\)/g)].map(match => match[1]))];
  for (const asset of assets) {
    const svg = read(asset.slice(1));
    assert.doesNotMatch(svg, /currentColor|prefers-color-scheme/i, `${asset} draws in fixed colours`);
    assert.match(svg, /fill="#|stroke="#|stop-color="#/i, `${asset} names its colours`);
  }
  const marks = css.split("\n").filter(line => line.includes(".agent-logo")).join("\n");
  assert.doesNotMatch(css, /mask|currentColor|data-theme/, "no mask or theme rule draws a mark");
  assert.doesNotMatch(marks, /var\(--(?:ink|text|pine|accent|paper|milk)/, "no theme colour draws a mark");
  assert.doesNotMatch(css, /\.agent-logo\[data-agent-id="[\w-]+"\][^{]*\{[^}]*\bcolor:/, "no mark is coloured by the text colour");
  // Provider marks in the limits capsule and sheet follow the same rule.
  const workspace = read("modules/workspace.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const provider = workspace.split("\n").filter(line => line.includes(".workspace-provider-logo") && !line.includes(".workspace-limit") && !line.includes(".usage-")).join("\n");
  assert.doesNotMatch(provider, /mask|currentColor|color:\s*var\(--/, "provider marks are drawn as images");
  for (const [logo, file] of [["codex", "codex.svg"], ["openai", "openai.svg"], ["claude", "claude.svg"], ["opencode", "opencode.svg"], ["grok", "grok.svg"], ["minimax", "minimax.png"]])
    assert.ok(provider.includes(`[data-logo="${logo}"] { --workspace-provider-mark: url("/agent-logos/v2/${file}"); }`), logo);
  assert.match(read("modules/workspace.js"), /logo\.dataset\.logo = value\.includes\("codex"\) \? "codex" : value\.includes\("openai"\) \? "openai"/, "Codex limits show the Codex mark");
});
test("clients from before v2 still find their v1 marks", () => {
  for (const file of ["pi", "claude", "codex", "opencode", "grok", "antigravity", "cline", "kilo", "hermes", "omp", "openai", "agent"]) assert.match(read(`agent-logos/v1/${file}.svg`), /<svg\b/);
  assert.ok(fs.existsSync(path.join(root, "agent-logos/v1/minimax.png")));
});
test("chat identity changes and clearing do not alter the conversation title", () => {
  const source = read("app.js");
  const code = source.slice(source.indexOf("function setChatAgent("), source.indexOf("function setChatTitle("));
  const slot = { children: [], hidden: true, replaceChildren() { this.children = []; },
    classList: { toggle(name, hidden) { assert.equal(name, "hidden"); slot.hidden = hidden; } },
    appendChild(child) { this.children.push(child); } };
  const context = vm.createContext({ el: { chatAgentLogo: slot }, document: doc(), StepsembleAgentIdentity: identity });
  vm.runInContext(code, context);
  for (const id of ["claude-code", "codex", "pi", "unknown"]) {
    context.setChatAgent(id); assert.equal(slot.children.length, 1);
    assert.equal(slot.children[0].dataset.agentId, identity.lookup(id).id); assert.equal(slot.hidden, false);
  }
  context.setChatAgent(null); assert.equal(slot.hidden, true); assert.deepEqual(slot.children, []);
  assert.match(source, /setChatTitle\(sessionDisplayTitle\(s\)\);\s+setChatAgent\(s.agentId \?\? "pi"\)/);
  assert.match(source, /setChatAgent\(task.agentId \|\| "agent"\)/);
  assert.match(source, /if \(snapshot.agentId\) setChatAgent\(snapshot.agentId\)/);
});

test("a personal assistant is not offered as a new coding conversation", () => {
  assert.equal(identity.startsConversations({ id: "codex", installed: true, category: "coding" }), true);
  assert.equal(identity.startsConversations({ id: "hermes", installed: true, category: "personal" }), false);
  assert.equal(identity.startsConversations({ id: "kilo", installed: false, category: "coding" }), false);
  assert.equal(identity.startsConversations(null), false);
});
