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
// so that a line break inside the message cannot submit it early. Enter is a
// separate chunk: written together, some programs take it as pasted text.
function terminalSubmission(message, { bracketedPaste = false } = {}) {
  const text = terminalText(message);
  if (bracketedPaste && text.includes("\n")) return [PASTE_START + text + PASTE_END, KEYS.enter];
  return [text + KEYS.enter];
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

module.exports = { KEYS, MAX_TERMINAL_INPUT, terminalText, terminalSubmission, terminalTyping, createPasteModeTracker };
