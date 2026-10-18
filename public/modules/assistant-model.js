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

  function item(role, text = "") {
    return { id: `${role}-${++counter}`, role, text, thinking: "", tools: [], attachments: [], streaming: false, rev: 0 };
  }
  function userItem(text, attachments = []) {
    const value = item("user", text);
    value.attachments = [...attachments];
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
      items.push(item(role, typeof message?.text === "string" ? message.text : ""));
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

  function applyEvent(items, event) {
    const payload = event?.payload || {};
    switch (event?.type) {
      case "message.start": {
        settle(items);
        const value = item("assistant");
        value.streaming = true;
        items.push(value);
        return true;
      }
      case "message.delta":
      case "thinking.delta": {
        if (!payload.text) return false;
        const value = streaming(items);
        if (event.type === "message.delta") value.text += payload.text; else value.thinking += payload.text;
        value.rev += 1;
        return true;
      }
      case "tool.start": {
        const value = streaming(items);
        value.tools.push({ id: payload.tool_id || null, name: payload.name || "tool", detail: payload.args_text || payload.context || "", result: "", done: false });
        value.rev += 1;
        return true;
      }
      case "tool.complete": {
        const value = streaming(items);
        const tool = [...value.tools].reverse().find(entry => (payload.tool_id ? entry.id === payload.tool_id : !entry.done && entry.name === payload.name));
        if (!tool) return false;
        tool.done = true;
        tool.result = payload.summary || payload.result_text || "";
        value.rev += 1;
        return true;
      }
      case "message.complete": {
        const value = [...items].reverse().find(entry => entry.streaming);
        if (!value) return false;
        value.streaming = false;
        if (!value.text && typeof payload.text === "string") value.text = payload.text;
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

  return { chooseHermesMachine, fromHistory, withInflight, applyEvent, userItem, systemItem, formatWhen, sourceLabel, initials, colorFor,
    scheduleFromPicker, pickerFromSchedule, deliverTokens, withDeliver, routineName, profileIdFor };
});
