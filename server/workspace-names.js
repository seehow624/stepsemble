"use strict";

// Session names in the Workspace. A person can name any session, when it is
// created or later; a session nobody named takes its first message as its
// name, except Pi's, which names itself that way.

// One line of at most 120 characters.
function workspaceSessionName(value) {
  if (typeof value !== "string") return "";
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(line).slice(0, 120).join("").trim();
}

// Wide characters, such as Chinese, Japanese and Korean, take the room of two.
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}]/u;
const TITLE_WIDTH = 48;

// The first line of a message, cut to a short title: about 48 letters or 24
// Chinese characters, cut between words where it can be. A slash command,
// such as /login, names nothing.
function workspaceAutoName(value) {
  if (typeof value !== "string" || value.trim().startsWith("/")) return "";
  const line = value.split(/\r?\n/).map(row => row.replace(/^[\s#>*-]+/, "").trim()).find(Boolean) || "";
  const chars = Array.from(workspaceSessionName(line));
  const widths = chars.map(char => WIDE.test(char) ? 2 : 1);
  if (widths.reduce((sum, width) => sum + width, 0) <= TITLE_WIDTH) return chars.join("");
  let used = 0, end = 0;
  while (end < chars.length && used + widths[end] <= TITLE_WIDTH - 1) used += widths[end++];
  // A word in letters is not cut in two: the title ends at the space before
  // it instead, unless that word is very long.
  const space = chars.lastIndexOf(" ", end - 1);
  const splitsWord = widths[end] === 1 && chars[end] !== " "
    && chars.slice(space + 1, end).every((char, index) => widths[space + 1 + index] === 1);
  if (splitsWord && space > 0 && end - space <= 12) end = space;
  return chars.slice(0, end).join("").trim() + "…";
}

// The names agents give a session nobody named: the agent's name, alone or
// followed by part of the session's id, and OpenCode's "New session - …".
const AGENT_LABELS = ["Pi", "Claude Code", "Codex", "OpenCode", "Grok", "Grok Build", "Kilo Code", "Cline", "Hermes Agent", "Antigravity", "Google Antigravity"];
function workspacePlaceholderName(name) {
  const value = String(name || "").replace(/\s+/g, " ").trim();
  if (!value || /^New session - /.test(value)) return true;
  return AGENT_LABELS.some(label => {
    if (value === label) return true;
    const rest = value.startsWith(label + " ") ? value.slice(label.length + 1) : "";
    return rest.length >= 6 && /^[A-Za-z0-9_-]+$/.test(rest) && /\d/.test(rest);
  });
}

// Whether a session may still take its first message as its name. named is
// set when the session is created, true when a name was typed; a session
// from before then is judged by its name.
function workspaceMayAutoName(record) {
  if (!record || record.agentId === "pi" || record.named === true || record.autoNamed === true) return false;
  return record.named === false || workspacePlaceholderName(record.name);
}

module.exports = { workspaceSessionName, workspaceAutoName, workspacePlaceholderName, workspaceMayAutoName };
