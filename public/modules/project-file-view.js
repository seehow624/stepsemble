(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.stepsembleProjectFileView = api;
})(typeof window === "object" ? window : null, function () {
  "use strict";
  const MAX_DIFF = 128 * 1024;
  const MAX_LINES = 5000;
  const lines = value => String(value || "").replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const first = (...values) => values.find(value => typeof value === "string");

  function editDetails(args, changes) {
    if (!changes.length) return [];
    let budget = 512 * 1024;
    const value = args && typeof args === "object" ? args : {};
    const patch = first(value.patch, value.patchText, value.patch_text, value.input, typeof args === "string" ? args : null) || "";
    const patches = new Map();
    let target = null;
    for (const line of patch.slice(0, MAX_DIFF * 4).split("\n")) {
      const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
      if (match) { target = match[1].trim(); patches.set(target, []); }
      else if (target && !line.startsWith("***")) patches.get(target).push(line);
    }
    return changes.map(change => {
      const sections = [];
      let truncated = false;
      function add(text, kind = "diff") {
        if (typeof text !== "string" || !text) return;
        const limit = Math.min(budget, MAX_DIFF);
        truncated ||= text.length > limit;
        if (!limit) return;
        const diff = text.slice(0, limit); budget -= diff.length;
        sections.push({ kind, diff });
      }
      if (Array.isArray(value.changes)) {
        const native = value.changes.find(item => item?.path === change.path);
        truncated ||= native?.diffTruncated === true;
        if (native?.diff) {
          const kind = typeof native.kind === "string" ? native.kind : native.kind?.type;
          const diff = native.diff;
          if ((kind === "add" || kind === "delete") && !/^@@|^diff |^--- /m.test(diff)) {
            add(lines(diff).map(line => (kind === "add" ? "+" : "-") + line).join("\n"), "excerpt");
          } else add(diff);
        }
      } else if (patches.has(change.path)) {
        add(patches.get(change.path).join("\n"), "excerpt");
        truncated ||= patch.length > MAX_DIFF * 4;
      } else {
        const edits = Array.isArray(value.edits) ? value.edits.slice(0, 200) : [value];
        for (const edit of edits) {
          if (!edit || typeof edit !== "object") continue;
          const before = first(edit.oldText, edit.old_string, edit.oldString, edit.old_str, edit.old);
          const after = first(edit.newText, edit.new_string, edit.newString, edit.new_str, edit.new);
          if (before !== undefined && after !== undefined) {
            add([...(before ? lines(before).map(line => "-" + line) : []), ...(after ? lines(after).map(line => "+" + line) : [])].join("\n"), "excerpt");
          }
        }
        if (!sections.length) add(first(value.content, value.contents, value.file_text, value.text), "content");
      }
      return { ...change, sections, truncated };
    });
  }

  function relativeFile(cwd, file) {
    // Used only to offer “Open current file”. The Host independently enforces
    // real-path containment, including symlinks; never suffix-match a name.
    const root = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
    let value = String(file || "").replace(/\\/g, "/");
    if (value.startsWith(root + "/")) value = value.slice(root.length + 1);
    if (!root || !value || value.startsWith("/") || /^[a-z]:/i.test(value) || value.includes("\0") || value.split("/").includes("..")) return null;
    return value.replace(/^\.\//, "");
  }

  function diffRows(text) {
    let oldLine = null, newLine = null;
    return lines(text).slice(0, MAX_LINES).map(raw => {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (raw.startsWith("@@")) {
        oldLine = hunk ? Number(hunk[1]) : null;
        newLine = hunk ? Number(hunk[2]) : null;
        return { text: raw, kind: "hunk", old: null, next: null };
      }
      if (/^(?:diff |index |--- |\+\+\+ |\\ No newline|new file|deleted file|similarity |rename |old mode|new mode)/.test(raw)) return { text: raw, kind: "meta", old: null, next: null };
      const kind = raw.startsWith("+") ? "add" : raw.startsWith("-") ? "del" : "";
      const row = { text: /^[ +\-]/.test(raw) ? raw.slice(1) : raw, kind, old: kind === "add" ? null : oldLine, next: kind === "del" ? null : newLine };
      if (kind !== "add" && oldLine !== null) oldLine++;
      if (kind !== "del" && newLine !== null) newLine++;
      return row;
    });
  }

  function highlight(code, file) {
    if (code.length > 8000 || !/\.(?:[cm]?[jt]sx?|json|css|scss|html?|vue|svelte|py|rb|sh|bash|zsh|swift|rs|go|[ch](?:pp)?|java|ya?ml|toml|sql)$/i.test(file)) return [{ text: code }];
    const hashComment = /\.(?:py|rb|sh|bash|zsh|ya?ml|toml)$/i.test(file);
    const expression = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*|\/\*.*?(?:\*\/|$)|#.*|\b(?:async|await|const|let|var|function|return|throw|new|if|else|for|while|of|in|import|from|export|default|class|extends|try|catch|finally|true|false|null|undefined|def|self|None|True|False|fn|pub|use|struct|impl|func|guard|enum|case|switch|break|continue|package|interface|type|public|private|static|void)\b|\b\d+(?:\.\d+)?\b)/g;
    const result = []; let end = 0;
    for (const match of code.matchAll(expression)) {
      if (match.index > end) result.push({ text: code.slice(end, match.index) });
      const text = match[0];
      const kind = /^['"`]/.test(text) ? "string" : /^\/[/\*]/.test(text) || (hashComment && text.startsWith("#")) ? "comment" : /^\d/.test(text) ? "number" : text.startsWith("#") ? "" : "keyword";
      result.push({ text, kind }); end = match.index + text.length;
    }
    if (end < code.length) result.push({ text: code.slice(end) });
    return result;
  }

  function codeBlock(document, text, file, { diff = false } = {}) {
    const pre = document.createElement("pre"); pre.className = "project-code";
    pre.tabIndex = 0;
    const rows = diff ? diffRows(text) : lines(text).slice(0, MAX_LINES).map((text, index) => ({ text, next: index + 1 }));
    for (const row of rows) {
      // File identity is already in the card header. Keep actual mode/rename
      // notices, but leave Git's transport headers out of the reading view.
      if (row.kind === "meta" && /^(?:diff |index |--- |\+\+\+ )/.test(row.text)) continue;
      const line = document.createElement("span"); line.className = "project-code-line" + (row.kind ? " " + row.kind : "");
      for (const number of [row.next ?? row.old]) {
        const gutter = document.createElement("span"); gutter.className = "project-code-number";
        gutter.setAttribute("aria-hidden", "true"); gutter.textContent = number == null ? "" : String(number); line.append(gutter);
      }
      if (diff) {
        const sign = document.createElement("span"); sign.className = "project-code-sign"; sign.setAttribute("aria-hidden", "true");
        sign.textContent = row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""; line.append(sign);
      }
      const content = document.createElement("code");
      for (const part of ["meta", "hunk"].includes(row.kind) ? [{ text: row.text }] : highlight(row.text, file)) {
        const span = document.createElement("span"); if (part.kind) span.className = `syntax-${part.kind}`;
        span.textContent = part.text; content.append(span);
      }
      line.append(content); pre.append(line);
    }
    return pre;
  }
  return Object.freeze({ editDetails, relativeFile, diffRows, highlight, codeBlock, lineCount: value => lines(value).length, MAX_LINES, MAX_DIFF });
});
