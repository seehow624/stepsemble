"use strict";

// What a person types at a terminal, as bytes. The conversation terminal
// (/login, /logout, /status) and the terminal view of a CLI session share it.

// Keys a phone keyboard cannot type, mapped to the bytes a terminal sends.
const KEYS = Object.freeze({
  enter: "\r", tab: "\t", escape: "\x1b", backspace: "\x7f", space: " ",
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
  "ctrl-c": "\x03", "ctrl-d": "\x04",
});

const MAX_TERMINAL_INPUT = 8192;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

// Text typed into a full-screen program: printable characters, tabs and line
// breaks. Escape and the other control bytes would act as keys there, and an
// end-of-paste marker inside a paste would end it early.
function terminalText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

// A message sent from the composer, as a person would submit it: the text,
// then Enter. Full-screen programs read Enter as a carriage return; a line
// feed only starts a new line in their input box, so it never submits. When
// the program has turned bracketed paste on, several lines go in as one paste
// so that a line break inside the message cannot submit it early. Enter is
// always a separate chunk: Codex takes an Enter that arrives with, or right
// after, fast typing as part of a paste and only adds a line.
function terminalSubmission(message, { bracketedPaste = false } = {}) {
  const text = terminalText(message);
  if (!text) return [KEYS.enter];
  if (bracketedPaste && text.includes("\n")) return [PASTE_START + text + PASTE_END, KEYS.enter];
  return [text, KEYS.enter];
}

// Text typed or pasted straight into the terminal view, without Enter.
function terminalTyping(value, { bracketedPaste = false } = {}) {
  const text = terminalText(value);
  return bracketedPaste && text.includes("\n") ? PASTE_START + text + PASTE_END : text;
}

// Follows a program's bracketed-paste switch (DECSET 2004) in its output.
// A switch can be split across output chunks, so an unfinished one is kept.
function createPasteModeTracker() {
  let enabled = false, tail = "";
  const pattern = /\x1b\[\?([0-9;]+)([hl])/g;
  return Object.freeze({
    observe(chunk) {
      const text = tail + String(chunk ?? "");
      pattern.lastIndex = 0;
      let match, end = 0;
      while ((match = pattern.exec(text))) {
        if (match[1].split(";").includes("2004")) enabled = match[2] === "h";
        end = pattern.lastIndex;
      }
      const rest = text.slice(end), escape = rest.lastIndexOf("\x1b");
      tail = escape >= 0 && rest.length - escape <= 16 ? rest.slice(escape) : "";
    },
    enabled: () => enabled,
  });
}

// Full-screen programs ask the terminal what it is before they draw; Codex
// waits about two seconds for each answer. A browser is too far away to
// answer inside their timeouts, so answer the common questions here, once per
// question, the way a plain xterm that has just opened would.
const QUERY_PATTERN = /\x1b\[(?:0?c|>0?c|5n|6n|\?[0-9]+\$p|18t|14t|>0?q)|\x1b\](?:10|11);\?(?:\x07|\x1b\\)/g;

function queryAnswer(query, { cols, rows }) {
  if (query === "\x1b[c" || query === "\x1b[0c") return "\x1b[?62;22c";
  if (query === "\x1b[>c" || query === "\x1b[>0c") return "\x1b[>1;10;0c";
  if (query === "\x1b[5n") return "\x1b[0n";
  if (query === "\x1b[6n") return "\x1b[1;1R";
  if (query === "\x1b[18t") return "\x1b[8;" + rows + ";" + cols + "t";
  if (query === "\x1b[14t") return "\x1b[4;" + rows * 16 + ";" + cols * 8 + "t";
  if (query === "\x1b[>q" || query === "\x1b[>0q") return "\x1bP>|Stepsemble\x1b\\";
  const mode = /^\x1b\[\?([0-9]+)\$p$/.exec(query);
  if (mode) return "\x1b[?" + mode[1] + ";0$y";
  if (query.startsWith("\x1b]10;")) return "\x1b]10;rgb:e6e6/e6e6/e6e6\x1b\\";
  if (query.startsWith("\x1b]11;")) return "\x1b]11;rgb:1c1c/1c1c/1c1c\x1b\\";
  return "";
}

function createQueryResponder({ cols, rows, write }) {
  let tail = "";
  return chunk => {
    const combined = tail + chunk;
    QUERY_PATTERN.lastIndex = 0;
    let match;
    while ((match = QUERY_PATTERN.exec(combined))) {
      if (match.index + match[0].length <= tail.length) continue;
      const answer = queryAnswer(match[0], { cols, rows });
      if (answer) write(answer);
    }
    tail = combined.slice(-24);
  };
}

module.exports = {
  KEYS, MAX_TERMINAL_INPUT, terminalText, terminalSubmission, terminalTyping, createPasteModeTracker,
  queryAnswer, createQueryResponder,
};
