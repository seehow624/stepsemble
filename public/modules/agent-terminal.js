(function expose(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.stepsembleAgentTerminal = Object.freeze(api);
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";

  // A small terminal screen for the conversation terminal (/login, /logout,
  // /status). Sign-in commands print plain lines, but several of them draw
  // full-screen menus with cursor movement, so the output is replayed onto a
  // grid the way a terminal would, instead of being shown as raw text.

  const DEFAULT_ATTR = Object.freeze({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false });
  const BASIC = ["#1c1c1c", "#e05561", "#8cc265", "#d18f52", "#4aa5f0", "#c162de", "#42b3c2", "#d7dae0",
    "#5c6370", "#ff616e", "#a5e075", "#f0a45d", "#4dc4ff", "#de73ff", "#4cd1e0", "#ffffff"];

  // East Asian wide characters and most emoji take two cells.
  function charWidth(code) {
    if (code < 0x1100) return 1;
    if ((code >= 0x1100 && code <= 0x115f) || code === 0x2329 || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1f64f) || (code >= 0x1f900 && code <= 0x1f9ff)
      || (code >= 0x20000 && code <= 0x3fffd)) return 2;
    if ((code >= 0x0300 && code <= 0x036f) || (code >= 0x200b && code <= 0x200f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
    return 1;
  }

  function color256(index) {
    if (index < 16) return BASIC[index];
    if (index >= 232) { const level = 8 + (index - 232) * 10; return "rgb(" + level + "," + level + "," + level + ")"; }
    const value = index - 16, steps = [0, 95, 135, 175, 215, 255];
    return "rgb(" + steps[Math.floor(value / 36)] + "," + steps[Math.floor(value / 6) % 6] + "," + steps[value % 6] + ")";
  }

  function blankRow(cols, attr = DEFAULT_ATTR) {
    const row = new Array(cols);
    for (let i = 0; i < cols; i++) row[i] = { ch: " ", attr };
    row.wrapped = false;
    return row;
  }

  function createScreen({ cols = 100, rows = 30, scrollback = 400 } = {}) {
    let width = cols, height = rows;
    let primary = [], alternate = null, lines = [], history = [];
    let cursor = { x: 0, y: 0 }, saved = { x: 0, y: 0, attr: DEFAULT_ATTR }, attr = DEFAULT_ATTR;
    let top = 0, bottom = height - 1, wrapPending = false, cursorVisible = true;
    let state = "text", params = "", osc = "", pendingCharset = false;
    const links = [];
    let linkTarget = null;
    let revision = 0;

    function reset() {
      primary = []; for (let y = 0; y < height; y++) primary.push(blankRow(width));
      lines = primary; alternate = null; history = [];
      cursor = { x: 0, y: 0 }; saved = { x: 0, y: 0, attr: DEFAULT_ATTR }; attr = DEFAULT_ATTR;
      top = 0; bottom = height - 1; wrapPending = false; cursorVisible = true;
      state = "text"; params = ""; osc = ""; pendingCharset = false; linkTarget = null;
      revision++;
    }
    reset();

    const clampX = x => Math.max(0, Math.min(width - 1, x));
    const clampY = y => Math.max(0, Math.min(height - 1, y));

    function scrollUp(count = 1) {
      for (let i = 0; i < count; i++) {
        const removed = lines.splice(top, 1)[0];
        if (lines === primary && top === 0 && removed) { history.push(removed); if (history.length > scrollback) history.shift(); }
        lines.splice(bottom, 0, blankRow(width, attr.bg ? { ...DEFAULT_ATTR, bg: attr.bg } : DEFAULT_ATTR));
      }
    }
    function scrollDown(count = 1) {
      for (let i = 0; i < count; i++) {
        lines.splice(bottom, 1);
        lines.splice(top, 0, blankRow(width));
      }
    }
    function lineFeed() {
      wrapPending = false;
      if (cursor.y === bottom) scrollUp();
      else cursor.y = clampY(cursor.y + 1);
    }
    function put(ch, cellWidth) {
      if (cellWidth === 0) {
        const x = Math.max(0, cursor.x - 1), cell = lines[cursor.y][x];
        if (cell) cell.ch += ch;
        return;
      }
      if (wrapPending) {
        wrapPending = false;
        lines[cursor.y].wrapped = true;
        cursor.x = 0; lineFeed();
        lines[cursor.y].continued = true;
      }
      if (cellWidth === 2 && cursor.x === width - 1) {
        lines[cursor.y][cursor.x] = { ch: " ", attr };
        lines[cursor.y].wrapped = true;
        cursor.x = 0; lineFeed(); lines[cursor.y].continued = true;
      }
      const cellAttr = linkTarget ? { ...attr, link: linkTarget } : attr;
      lines[cursor.y][cursor.x] = { ch, attr: cellAttr };
      if (cellWidth === 2 && cursor.x + 1 < width) lines[cursor.y][cursor.x + 1] = { ch: "", attr: cellAttr };
      const next = cursor.x + cellWidth;
      if (next >= width) { cursor.x = width - 1; wrapPending = true; }
      else cursor.x = next;
    }
    function eraseInLine(mode) {
      const row = lines[cursor.y];
      const from = mode === 1 || mode === 2 ? 0 : cursor.x;
      const to = mode === 0 ? width - 1 : mode === 1 ? cursor.x : width - 1;
      for (let x = from; x <= to; x++) row[x] = { ch: " ", attr: attr.bg ? { ...DEFAULT_ATTR, bg: attr.bg } : DEFAULT_ATTR };
      if (mode !== 1) row.wrapped = false;
    }
    function eraseInDisplay(mode) {
      if (mode === 3) { history = []; return; }
      if (mode === 2) { for (let y = 0; y < height; y++) lines[y] = blankRow(width); return; }
      if (mode === 0) { eraseInLine(0); for (let y = cursor.y + 1; y < height; y++) lines[y] = blankRow(width); return; }
      if (mode === 1) { eraseInLine(1); for (let y = 0; y < cursor.y; y++) lines[y] = blankRow(width); }
    }
    function sgr(values) {
      const list = values.length ? values : [0];
      let next = { ...attr };
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (v === 0) next = { ...DEFAULT_ATTR };
        else if (v === 1) next.bold = true;
        else if (v === 2) next.dim = true;
        else if (v === 3) next.italic = true;
        else if (v === 4) next.underline = true;
        else if (v === 7) next.inverse = true;
        else if (v === 22) { next.bold = false; next.dim = false; }
        else if (v === 23) next.italic = false;
        else if (v === 24) next.underline = false;
        else if (v === 27) next.inverse = false;
        else if (v >= 30 && v <= 37) next.fg = BASIC[v - 30];
        else if (v >= 90 && v <= 97) next.fg = BASIC[v - 90 + 8];
        else if (v === 39) next.fg = null;
        else if (v >= 40 && v <= 47) next.bg = BASIC[v - 40];
        else if (v >= 100 && v <= 107) next.bg = BASIC[v - 100 + 8];
        else if (v === 49) next.bg = null;
        else if (v === 38 || v === 48) {
          const key = v === 38 ? "fg" : "bg";
          if (list[i + 1] === 5 && Number.isInteger(list[i + 2])) { next[key] = color256(Math.max(0, Math.min(255, list[i + 2]))); i += 2; }
          else if (list[i + 1] === 2 && list.length >= i + 5) {
            next[key] = "rgb(" + [list[i + 2], list[i + 3], list[i + 4]].map(c => Math.max(0, Math.min(255, c | 0))).join(",") + ")"; i += 4;
          }
        }
      }
      attr = Object.freeze(next);
    }
    function setMode(privateMode, values, enabled) {
      if (!privateMode) return;
      for (const v of values) {
        if (v === 25) cursorVisible = enabled;
        else if (v === 1049 || v === 1047 || v === 47) {
          if (enabled && !alternate) {
            if (v === 1049) saved = { x: cursor.x, y: cursor.y, attr };
            alternate = []; for (let y = 0; y < height; y++) alternate.push(blankRow(width));
            lines = alternate;
          } else if (!enabled && alternate) {
            alternate = null; lines = primary;
            if (v === 1049) { cursor = { x: saved.x, y: saved.y }; attr = saved.attr; }
          }
          top = 0; bottom = height - 1; wrapPending = false;
        }
      }
    }
    function csi(final, raw) {
      const privateMode = raw.startsWith("?");
      const body = raw.replace(/^[?>=<]/, "").replace(/[ -/]+$/, "");
      const values = body === "" ? [] : body.split(";").map(part => part === "" ? 0 : Number.parseInt(part.split(":")[0], 10) || 0);
      const n = values[0] || 1;
      if (/^[>=<]/.test(raw) && final !== "m") return;
      switch (final) {
        case "A": cursor.y = Math.max(cursor.y >= top ? top : 0, cursor.y - n); wrapPending = false; break;
        case "B": cursor.y = Math.min(cursor.y <= bottom ? bottom : height - 1, cursor.y + n); wrapPending = false; break;
        case "C": cursor.x = clampX(cursor.x + n); wrapPending = false; break;
        case "D": cursor.x = clampX(cursor.x - n); wrapPending = false; break;
        case "E": cursor.x = 0; cursor.y = clampY(cursor.y + n); wrapPending = false; break;
        case "F": cursor.x = 0; cursor.y = clampY(cursor.y - n); wrapPending = false; break;
        case "G": case "\x60": cursor.x = clampX(n - 1); wrapPending = false; break;
        case "d": cursor.y = clampY(n - 1); wrapPending = false; break;
        case "H": case "f": cursor.y = clampY((values[0] || 1) - 1); cursor.x = clampX((values[1] || 1) - 1); wrapPending = false; break;
        case "J": eraseInDisplay(values[0] || 0); break;
        case "K": eraseInLine(values[0] || 0); break;
        case "L": if (cursor.y >= top && cursor.y <= bottom) for (let i = 0; i < n; i++) { lines.splice(bottom, 1); lines.splice(cursor.y, 0, blankRow(width)); } break;
        case "M": if (cursor.y >= top && cursor.y <= bottom) for (let i = 0; i < n; i++) { lines.splice(cursor.y, 1); lines.splice(bottom, 0, blankRow(width)); } break;
        case "P": { const row = lines[cursor.y]; row.splice(cursor.x, n); while (row.length < width) row.push({ ch: " ", attr: DEFAULT_ATTR }); break; }
        case "@": { const row = lines[cursor.y]; for (let i = 0; i < n; i++) row.splice(cursor.x, 0, { ch: " ", attr: DEFAULT_ATTR }); row.length = width; break; }
        case "X": for (let x = cursor.x; x < Math.min(width, cursor.x + n); x++) lines[cursor.y][x] = { ch: " ", attr: DEFAULT_ATTR }; break;
        case "S": scrollUp(n); break;
        case "T": scrollDown(n); break;
        case "r": top = clampY((values[0] || 1) - 1); bottom = values[1] ? clampY(values[1] - 1) : height - 1; if (bottom <= top) { top = 0; bottom = height - 1; } cursor = { x: 0, y: 0 }; break;
        case "s": saved = { x: cursor.x, y: cursor.y, attr }; break;
        case "u": cursor = { x: saved.x, y: saved.y }; break;
        case "h": setMode(privateMode, values, true); break;
        case "l": setMode(privateMode, values, false); break;
        case "m": if (!/^[>=<]/.test(raw)) sgr(values); break;
        default: break;
      }
    }
    function oscCommand(value) {
      const separator = value.indexOf(";");
      const code = separator >= 0 ? value.slice(0, separator) : value;
      if (code !== "8") return;
      const rest = value.slice(separator + 1), second = rest.indexOf(";");
      const target = second >= 0 ? rest.slice(second + 1) : "";
      if (!target) { linkTarget = null; return; }
      try {
        const parsed = new URL(target);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          linkTarget = parsed.href;
          if (!links.includes(parsed.href)) { links.push(parsed.href); if (links.length > 20) links.shift(); }
        } else linkTarget = null;
      } catch { linkTarget = null; }
    }

    function write(text) {
      const input = Array.from(String(text || ""));
      for (let index = 0; index < input.length; index++) {
        const ch = input[index];
        const code = ch.codePointAt(0);
        if (state === "esc") {
          if (ch === "[") { state = "csi"; params = ""; continue; }
          if (ch === "]") { state = "osc"; osc = ""; continue; }
          if (ch === "P" || ch === "_" || ch === "^" || ch === "X") { state = "string"; continue; }
          state = "text";
          if (pendingCharset) { pendingCharset = false; continue; }
          if (ch === "(" || ch === ")" || ch === "*" || ch === "+") { state = "charset"; continue; }
          if (ch === "7") saved = { x: cursor.x, y: cursor.y, attr };
          else if (ch === "8") { cursor = { x: saved.x, y: saved.y }; attr = saved.attr; }
          else if (ch === "D") lineFeed();
          else if (ch === "E") { cursor.x = 0; lineFeed(); }
          else if (ch === "M") { if (cursor.y === top) scrollDown(); else cursor.y = clampY(cursor.y - 1); }
          else if (ch === "c") reset();
          continue;
        }
        if (state === "charset") { state = "text"; continue; }
        if (state === "csi") {
          if (code >= 0x40 && code <= 0x7e) { csi(ch, params); state = "text"; }
          else if (params.length < 64) params += ch;
          else state = "text";
          continue;
        }
        if (state === "osc") {
          if (ch === "\x07") { oscCommand(osc); state = "text"; }
          else if (ch === "\x1b") state = "osc-esc";
          else if (osc.length < 4096) osc += ch;
          continue;
        }
        if (state === "osc-esc") {
          oscCommand(osc);
          // ESC \ ends the string; any other ESC starts a new sequence.
          if (ch === "\\") state = "text";
          else { state = "esc"; index--; }
          continue;
        }
        if (state === "string") { if (ch === "\x1b") state = "string-esc"; else if (ch === "\x07") state = "text"; continue; }
        if (state === "string-esc") {
          if (ch === "\\") state = "text";
          else { state = "esc"; index--; }
          continue;
        }
        if (ch === "\x1b") { state = "esc"; continue; }
        if (ch === "\r") { cursor.x = 0; wrapPending = false; continue; }
        if (ch === "\n" || ch === "\x0b" || ch === "\x0c") { lineFeed(); continue; }
        if (ch === "\b") { cursor.x = Math.max(0, cursor.x - 1); wrapPending = false; continue; }
        if (ch === "\t") { cursor.x = clampX(Math.floor(cursor.x / 8) * 8 + 8); continue; }
        if (code < 0x20 || code === 0x7f) continue;
        put(ch, charWidth(code));
      }
      revision++;
    }

    // Rows as runs of text with the same look, for rendering.
    function styledRows({ includeHistory = true } = {}) {
      const source = includeHistory && lines === primary ? history.concat(lines) : lines;
      let last = source.length - 1;
      const cursorRow = (includeHistory && lines === primary ? history.length : 0) + cursor.y;
      while (last > cursorRow && source[last].every(cell => cell.ch === " " && !cell.attr.bg && !cell.attr.inverse)) last--;
      return source.slice(0, last + 1).map(row => {
        const runs = [];
        let current = null;
        for (const cell of row) {
          if (current && current.attr === cell.attr) current.text += cell.ch;
          else { current = { text: cell.ch, attr: cell.attr }; runs.push(current); }
        }
        return runs;
      });
    }

    function textRows({ includeHistory = true } = {}) {
      const source = includeHistory && lines === primary ? history.concat(lines) : lines;
      return source.map(row => row.map(cell => cell.ch).join("").replace(/\s+$/, ""));
    }

    // Joins rows the terminal wrapped, so a long sign-in link is one line.
    function logicalText({ includeHistory = true } = {}) {
      const source = includeHistory && lines === primary ? history.concat(lines) : lines;
      let result = "";
      source.forEach((row, index) => {
        const textValue = row.map(cell => cell.ch).join("");
        result += row.wrapped ? textValue : textValue.replace(/\s+$/, "") + (index < source.length - 1 ? "\n" : "");
      });
      return result;
    }

    return {
      write, reset, styledRows, textRows, logicalText,
      get cols() { return width; }, get rows() { return height; },
      get cursor() { return { x: cursor.x, y: cursor.y, visible: cursorVisible }; },
      get alternate() { return !!alternate; },
      get links() { return links.slice(); },
      get revision() { return revision; },
    };
  }

  const ANSI = /\x1b\[[0-9;?<>=:]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P_^X][\s\S]*?\x1b\\|\x1b[()*+][0-9A-Za-z]|\x1b[@-Z\\-_]/g;
  function stripAnsi(text) { return String(text || "").replace(ANSI, ""); }

  function trimLink(value) {
    let link = value.replace(/[)\].,;:!?'">]+$/, "");
    const opens = (link.match(/\(/g) || []).length, closes = (link.match(/\)/g) || []).length;
    if (closes > opens) link = link.replace(/\)+$/, "");
    return link;
  }

  // Sign-in links in the order they appeared, newest last.
  function extractLinks(text, extra = []) {
    const found = [];
    const add = value => {
      try {
        const parsed = new URL(value);
        if ((parsed.protocol === "https:" || parsed.protocol === "http:") && !found.includes(parsed.href)) found.push(parsed.href);
      } catch {}
    };
    for (const link of extra) add(link);
    const plain = stripAnsi(text);
    for (const match of plain.matchAll(/https?:\/\/[^\s"'<>\x07\x1b│|]+/g)) add(trimLink(match[0]));
    return found.slice(-6);
  }

  // One-time device codes such as "ABCD-12345", printed near the word "code".
  function extractCodes(text) {
    const plain = stripAnsi(text);
    const codes = [];
    for (const match of plain.matchAll(/(?:^|[^A-Za-z0-9-])([A-Z0-9]{4,5}-[A-Z0-9]{4,5})(?![A-Za-z0-9-])/g)) {
      const code = match[1];
      const before = plain.slice(Math.max(0, match.index - 240), match.index).toLowerCase();
      if (!/code|驗證碼|代碼|代码|コード|코드/.test(before)) continue;
      if (/^\d{4}-\d{4,5}$/.test(code) && /\d{4}-\d{2}/.test(code)) continue;
      if (!codes.includes(code)) codes.push(code);
    }
    return codes.slice(-3);
  }

  // Whether the last lines ask for something that should not be shown.
  function looksSecretPrompt(rows) {
    const tail = (Array.isArray(rows) ? rows : []).filter(line => String(line).trim()).slice(-3).join("\n");
    return /api[\s_-]?key|access[\s_-]?token|\btoken\b|password|passphrase|secret|金鑰|密钥|密碼|密码|キー|토큰/i.test(tail);
  }

  function parseCommand(text) {
    const match = /^\/(login|logout|status)(?:\s+(.*))?$/i.exec(String(text || "").trim());
    if (!match) return null;
    return { action: match[1].toLowerCase(), argument: String(match[2] || "").trim() };
  }

  return { createScreen, stripAnsi, extractLinks, extractCodes, looksSecretPrompt, parseCommand, charWidth };
});
