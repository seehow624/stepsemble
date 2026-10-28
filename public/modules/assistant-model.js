(function expose(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.StepsembleAssistantModel = Object.freeze(api);
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";

  // Pure pieces of the assistant page: which computer to use, and how Hermes
  // history and live events become a transcript. No DOM, so Node tests them.

  const SOURCES = Object.freeze({ telegram: "Telegram", discord: "Discord", slack: "Slack", whatsapp: "WhatsApp", signal: "Signal",
    matrix: "Matrix", email: "Email", sms: "SMS", cron: "Cron", webhook: "Webhook", api_server: "API", tui: "TUI", cli: "CLI",
    desktop: "Desktop", dashboard: "Web", web: "Web", acp: "ACP" });
  const PALETTE = ["#5b8def", "#d9822b", "#3aa675", "#b25fd3", "#d64f6a", "#2a9fb0", "#8a8f2b", "#7a6cf0"];
  let counter = 0;

  function chooseHermesMachine(rows, savedId) {
    const choices = (Array.isArray(rows) ? rows : []).filter(row => row && row.status && row.status.installed === true);
    const selected = choices.find(row => row.id === savedId) || choices.find(row => row.self) || choices[0] || null;
    return { choices, selected };
  }

  // at: when the message was written, in milliseconds (0 while it is being written).
  // status: what the Bot is doing before it has words ("compacting"). delivery:
  // what became of a message sent while the Bot worked ("steered" into that
  // work, "queued" for the next turn, "dropped" by Stop). kind: a notice's kind.
  function item(role, text = "") {
    return { id: `${role}-${++counter}`, role, text, thinking: "", tools: [], attachments: [], streaming: false, rev: 0, at: 0, status: "", delivery: "", kind: "" };
  }
  // Hermes gives seconds, the Host's events milliseconds.
  const millis = value => { const number = Number(value); return Number.isFinite(number) && number > 0 ? (number < 1e12 ? number * 1000 : number) : 0; };
  function userItem(text, attachments = [], at = Date.now()) {
    const value = item("user", text);
    value.attachments = [...attachments];
    value.at = millis(at);
    return value;
  }
  const systemItem = text => item("system", text);

  function fromHistory(messages) {
    const items = [];
    for (const message of Array.isArray(messages) ? messages : []) {
      if (message?.role === "tool") {
        // 只有連續、沒有文字的工具紀錄合併，不跨過真正的回答。
        const previous = items.at(-1);
        const value = previous?.role === "assistant" && !previous.text && previous.tools.length ? previous : item("assistant");
        value.tools.push({ id: null, name: message.name || "tool", detail: message.context || "", result: "", done: true });
        if (value !== previous) items.push(value);
        continue;
      }
      const role = message?.role === "user" ? "user" : message?.role === "system" ? "system" : "assistant";
      const value = item(role, typeof message?.text === "string" ? message.text : "");
      value.at = millis(message?.at);
      if (role === "assistant" && typeof message?.thinking === "string") value.thinking = message.thinking;
      if (role === "system" && typeof message?.kind === "string") value.kind = message.kind;
      items.push(value);
    }
    return items;
  }

  function withInflight(items, inflight) {
    if (!inflight) return items;
    const last = items[items.length - 1];
    if (inflight.user && !(last && last.role === "user" && last.text === inflight.user)) items.push(item("user", inflight.user));
    const live = item("assistant", inflight.assistant || "");
    live.streaming = true;
    items.push(live);
    return items;
  }

  function streaming(items) {
    for (let index = items.length - 1; index >= 0; index -= 1) if (items[index].streaming) return items[index];
    const value = item("assistant");
    value.streaming = true;
    items.push(value);
    return value;
  }
  function settle(items) {
    for (const value of items) if (value.streaming) { value.streaming = false; value.rev += 1; }
  }
  const live = items => [...items].reverse().find(entry => entry.streaming);

  // The Bot took the person's newest message into the work it is doing: what
  // it does from now on shows below that message, as a messaging app would.
  // An answer already being written stays where it is, in one piece.
  function continueBelow(items) {
    const current = live(items);
    if (!current || current.text || current === items.at(-1)) return;
    if (!current.tools.length && !current.thinking) { items.splice(items.indexOf(current), 1); items.push(current); return; }
    current.streaming = false; current.rev += 1;
    const next = item("assistant");
    next.streaming = true;
    items.push(next);
  }
  // Stop drops every message still waiting for its turn.
  function dropQueued(items) {
    for (const value of items) if (value.delivery === "queued") { value.delivery = "dropped"; value.rev += 1; }
  }

  function applyEvent(items, event) {
    const payload = event?.payload || {};
    switch (event?.type) {
      case "message.start": {
        settle(items);
        // What waited for this turn is being handled now.
        for (const value of items) if (value.delivery === "queued") { value.delivery = ""; value.rev += 1; }
        const value = item("assistant");
        value.streaming = true;
        items.push(value);
        return true;
      }
      // reasoning.delta is the Bot's own reasoning, sent while it thinks when
      // it shows it; thinking.delta is only Hermes's waiting line.
      case "message.delta":
      case "reasoning.delta": {
        if (!payload.text) return false;
        const value = streaming(items);
        if (event.type === "message.delta") value.text += payload.text; else value.thinking += payload.text;
        value.status = "";
        value.rev += 1;
        return true;
      }
      case "tool.start": {
        const value = streaming(items);
        value.tools.push({ id: payload.tool_id || null, name: payload.name || "tool", detail: payload.args_text || payload.context || "", result: "", done: false });
        value.status = "";
        value.rev += 1;
        return true;
      }
      case "tool.complete": {
        // A step started before the work moved below a new message ends where it began.
        const value = streaming(items);
        let owner = value, tool = [...value.tools].reverse().find(entry => (payload.tool_id ? entry.id === payload.tool_id : !entry.done && entry.name === payload.name));
        for (let index = items.length - 1; !tool && payload.tool_id && index >= 0; index -= 1) {
          owner = items[index];
          tool = owner.tools.find(entry => entry.id === payload.tool_id && !entry.done);
        }
        if (!tool) return false;
        tool.done = true;
        tool.result = payload.summary || payload.result_text || "";
        owner.rev += 1;
        return true;
      }
      case "status.update": {
        // Hermes compacting a long conversation, which can take a minute.
        const value = live(items);
        if (payload.kind === "process" && payload.text) { const notice = item("system", payload.text); notice.kind = "process"; items.push(notice); return true; }
        if (!value || !["compacting", "compacted"].includes(payload.kind)) return false;
        value.status = payload.kind === "compacting" ? "compacting" : "";
        value.rev += 1;
        return true;
      }
      case "message.complete": {
        // The turn has ended, whether or not this page saw it begin.
        const value = live(items);
        for (const entry of items) if (entry.delivery === "steered") { entry.delivery = ""; entry.rev += 1; }
        if (!value) return true;
        value.streaming = false;
        value.status = "";
        if (!value.text && typeof payload.text === "string") value.text = payload.text;
        // The whole reasoning comes with the end even when it was not shown while it was written.
        if (!value.thinking && typeof payload.reasoning === "string") value.thinking = payload.reasoning;
        value.at = millis(event.at) || Date.now();
        value.rev += 1;
        return true;
      }
      case "error":
        settle(items);
        items.push(item("system", payload.message || "Error"));
        return true;
      default:
        return false;
    }
  }

  function formatWhen(seconds, now = Date.now(), locale = "en") {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return "";
    const date = new Date(value < 1e12 ? value * 1000 : value), today = new Date(now);
    try {
      if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
      if (now - date.getTime() < 6 * 86_400_000 && date < today) return date.toLocaleDateString(locale, { weekday: "short" });
      return date.toLocaleDateString(locale, { month: "short", day: "numeric" });
    } catch { return date.toISOString().slice(0, 10); }
  }
  function sourceLabel(source) {
    const key = String(source || "").toLowerCase();
    return SOURCES[key] || (key ? key.slice(0, 20) : "");
  }
  function initials(name) {
    const text = String(name || "").trim();
    return text ? Array.from(text)[0].toUpperCase() : "?";
  }
  function colorFor(name, color) {
    if (/^#[0-9a-fA-F]{3,8}$/.test(String(color || ""))) return color;
    let hash = 0;
    for (const char of String(name || "")) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    return PALETTE[hash % PALETTE.length];
  }

  // The routine editor's picker, written as the schedule strings Hermes
  // accepts and read back from the schedule Hermes reports.
  const DAILY = /^(\d{1,2}) (\d{1,2}) \* \* \*$/, WEEKDAYS = /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/, WEEKLY = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/;
  const pad = value => String(value).padStart(2, "0");

  function scheduleFromPicker(picker = {}) {
    const time = /^(\d{1,2}):(\d{2})$/.exec(String(picker.time || ""));
    const hour = time ? Math.min(23, Number(time[1])) : 9, minute = time ? Math.min(59, Number(time[2])) : 0;
    switch (picker.kind) {
      case "daily": return `${minute} ${hour} * * *`;
      case "weekdays": return `${minute} ${hour} * * 1-5`;
      case "weekly": return `${minute} ${hour} * * ${Math.min(6, Math.max(0, Math.round(Number(picker.weekday) || 0)))}`;
      case "interval": return `every ${Math.max(1, Math.min(10_000, Math.round(Number(picker.every) || 1)))}${picker.unit === "h" ? "h" : "m"}`;
      case "once": return String(picker.at || "").trim();
      default: return String(picker.raw || "").trim();
    }
  }

  function pickerFromSchedule(schedule) {
    const value = schedule && typeof schedule === "object" ? schedule : { display: String(schedule || "") };
    const expr = String(value.expr || "").trim();
    const time = (minute, hour) => `${pad(hour)}:${pad(minute)}`;
    let match;
    if ((match = DAILY.exec(expr))) return { kind: "daily", time: time(match[1], match[2]) };
    if ((match = WEEKDAYS.exec(expr))) return { kind: "weekdays", time: time(match[1], match[2]) };
    if ((match = WEEKLY.exec(expr))) return { kind: "weekly", time: time(match[1], match[2]), weekday: Number(match[3]) };
    const minutes = Number(value.minutes);
    if (value.kind === "interval" && minutes > 0) return minutes % 60 === 0 ? { kind: "interval", every: minutes / 60, unit: "h" } : { kind: "interval", every: minutes, unit: "m" };
    if (value.kind === "once" && value.runAt) return { kind: "once", at: String(value.runAt).slice(0, 16) };
    return { kind: "advanced", raw: expr || String(value.display || "") };
  }

  function deliverTokens(value) {
    return [...new Set(String(value || "").split(",").map(token => token.trim()).filter(Boolean))];
  }
  function withDeliver(value, token, on) {
    const tokens = deliverTokens(value).filter(item => item !== token);
    if (on) tokens.push(token);
    const kept = tokens.length > 1 ? tokens.filter(item => item !== "local") : tokens;
    return kept.length ? kept.join(",") : "local";
  }
  const routineName = name => String(name || "").replace(/^\[bot:[^\]]{1,64}\]\s*/, "");
  // A suggested Hermes profile id for a new Bot name (the user can edit it).
  const profileIdFor = label => String(label || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 64);

  return { chooseHermesMachine, fromHistory, withInflight, applyEvent, continueBelow, dropQueued, userItem, systemItem, formatWhen, sourceLabel, initials, colorFor,
    scheduleFromPicker, pickerFromSchedule, deliverTokens, withDeliver, routineName, profileIdFor };
});
