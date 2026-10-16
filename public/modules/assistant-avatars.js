(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.StepsembleAssistantAvatars = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  function face(x = 32, y = 34, gap = 12, mood = "smile") {
    const eyes = mood === "happy"
      ? `<path d="M${x - gap / 2 - 2} ${y}q2-4 4 0m${gap - 4} 0q2-4 4 0" fill="none" stroke="#30364b" stroke-width="2.4" stroke-linecap="round"/>`
      : `<circle cx="${x - gap / 2}" cy="${y}" r="2.2" fill="#30364b"/><circle cx="${x + gap / 2}" cy="${y}" r="2.2" fill="#30364b"/><circle cx="${x - gap / 2 - .5}" cy="${y - .6}" r=".65" fill="#fff"/><circle cx="${x + gap / 2 - .5}" cy="${y - .6}" r=".65" fill="#fff"/>`;
    return eyes + `<path d="M${x - 2.5} ${y + 7}q2.5 ${mood === "happy" ? 3.5 : 2} 5 0" fill="none" stroke="#30364b" stroke-width="1.6" stroke-linecap="round"/>`;
  }

  const drawings = [
    ["orbit", `<path d="M31 16v-5" stroke="#8b7cb6" stroke-width="3" stroke-linecap="round"/><circle cx="31" cy="8" r="3.5" fill="#d0c1f2"/><rect x="8" y="30" width="7" height="13" rx="3.5" fill="#9c8bc9"/><rect x="49" y="30" width="7" height="13" rx="3.5" fill="#9c8bc9"/><rect x="14" y="18" width="36" height="34" rx="13" fill="#b9a6e7"/><path d="M21 21h14" stroke="#ded2fa" stroke-width="3" stroke-linecap="round"/><rect x="19" y="27" width="26" height="18" rx="8" fill="#f0eafa"/><path d="M23 53v4m18-4v4" stroke="#8b7cb6" stroke-width="5" stroke-linecap="round"/>${face(32, 34)}`],
    ["sprout", `<path d="M32 21c-9-1-15-7-13-14 9-1 15 5 13 14" fill="#93b89b"/><path d="M32 20c1-9 7-13 14-10-1 8-6 12-14 10" fill="#b8d5a7"/><path d="M15 39c0-14 6-22 17-22s17 8 17 22c0 10-7 16-17 16s-17-6-17-16" fill="#b2d0ad"/><path d="M17 41l-6 4m36-4 6 4" stroke="#84a58d" stroke-width="4" stroke-linecap="round"/><path d="M24 55l-1 3m17-3 1 3" stroke="#84a58d" stroke-width="4" stroke-linecap="round"/>${face(32, 35, 12, "happy")}`],
    ["pebble", `<path d="M16 43c-4-12 1-27 14-30 13-4 23 5 23 20 1 14-7 22-21 22-7 0-13-4-16-12" fill="#9fbedb"/><path d="M23 20c4-3 7-4 12-3" stroke="#d7e7f5" stroke-width="3" stroke-linecap="round"/><ellipse cx="19" cy="45" rx="5" ry="4" fill="#88a9cb"/><ellipse cx="45" cy="49" rx="5" ry="3" fill="#88a9cb"/>${face(34, 33, 13)}`],
    ["pip", `<path d="M28 18l4-9 4 9" fill="#ddb093"/><rect x="14" y="19" width="36" height="32" rx="16" fill="#efc0a6"/><path d="M19 44v8m26-8v8" stroke="#c49279" stroke-width="4" stroke-linecap="round"/><circle cx="23" cy="33" r="6" fill="#f9e1cd"/><circle cx="41" cy="33" r="6" fill="#f9e1cd"/><path d="M15 30l-5-3m39 3 5-3" stroke="#c49279" stroke-width="3" stroke-linecap="round"/>${face(32, 33, 18)}`],
    ["bloom", `<path d="M19 23c-4-9 7-16 13-8 6-8 17-1 13 8 10 0 14 12 5 17 4 10-8 17-15 11-6 8-19 3-18-7-11-1-13-15-3-20l5-1" fill="#d9a8bb"/><ellipse cx="32" cy="34" rx="17" ry="16" fill="#f1d3df"/><path d="M23 53l-2 3m20-3 2 3" stroke="#b7839c" stroke-width="4" stroke-linecap="round"/>${face(32, 32, 13, "happy")}`],
    ["comet", `<path d="M15 33L7 43l12-2m30-14 8-9-1 14" fill="#83a4c5"/><path d="M16 27c2-11 13-16 23-12 10 5 13 17 8 27-4 10-15 14-24 8-8-4-11-14-7-23" fill="#a5c4e2"/><path d="M23 22q8-7 16 0" fill="none" stroke="#dcebf7" stroke-width="3" stroke-linecap="round"/><path d="M24 51l-3 6m19-7 3 5" stroke="#83a4c5" stroke-width="4" stroke-linecap="round"/>${face(32, 33, 12)}`],
    ["ripple", `<path d="M13 38c0-16 8-25 19-25s19 9 19 25c0 9-5 11-10 6-5 7-11 7-16 0-6 6-12 3-12-6" fill="#91c9c7"/><path d="M22 48v8m10-8v11m10-11v8" stroke="#74aaa9" stroke-width="4" stroke-linecap="round"/><path d="M21 23q4-5 10-5" stroke="#cce9e1" stroke-width="3" fill="none" stroke-linecap="round"/>${face(32, 32, 13, "happy")}`],
    ["halo", `<ellipse cx="32" cy="10" rx="11" ry="3.5" fill="none" stroke="#d8c08a" stroke-width="3"/><path d="M15 34c0-12 7-19 17-19s17 7 17 19-7 21-17 21-17-9-17-21" fill="#e6d49e"/><path d="M13 37l-5-5m43 5 5-5" stroke="#c3ae76" stroke-width="4" stroke-linecap="round"/><ellipse cx="26" cy="53" rx="4" ry="3" fill="#c3ae76"/><ellipse cx="39" cy="53" rx="4" ry="3" fill="#c3ae76"/>${face(32, 33, 13)}`],
    ["moss", `<path d="M16 27c-5-10 6-17 14-12 4-10 20-5 19 6 9 8 5 18-2 20H17c-10-2-11-11-1-14" fill="#85a99a"/><rect x="16" y="25" width="32" height="28" rx="12" fill="#b6cfbb"/><path d="M23 51v6m18-6v6" stroke="#799c8d" stroke-width="4" stroke-linecap="round"/><path d="M20 24q4-4 8-3" stroke="#d6e4cb" stroke-width="3" fill="none" stroke-linecap="round"/>${face(32, 35, 12)}`],
    ["nova", `<path d="M17 25l-3-14 13 9m10 0 13-9-3 14" fill="#a496cb"/><rect x="13" y="20" width="38" height="31" rx="14" fill="#c4b9e8"/><rect x="18" y="27" width="28" height="17" rx="8.5" fill="#f0eafa"/><path d="M22 53l-3 4m23-4 3 4" stroke="#9a8abf" stroke-width="4" stroke-linecap="round"/>${face(32, 33, 14)}`],
    ["cloud", `<path d="M17 28c-1-12 12-19 20-10 8-4 17 2 16 11 9 8 2 23-10 22H21C7 52 3 34 17 28" fill="#d6dfeb"/><path d="M18 27c2-5 6-8 11-8" fill="none" stroke="#f5f6fa" stroke-width="3" stroke-linecap="round"/><path d="M24 52v5m17-5v5" stroke="#a4b4cb" stroke-width="4" stroke-linecap="round"/>${face(33, 34, 13, "happy")}`],
    ["echo", `<rect x="8" y="27" width="9" height="19" rx="4.5" fill="#b59a87"/><rect x="47" y="27" width="9" height="19" rx="4.5" fill="#b59a87"/><path d="M15 28c0-9 7-15 17-15s17 6 17 15" fill="none" stroke="#b59a87" stroke-width="4"/><rect x="14" y="23" width="36" height="29" rx="12" fill="#dbc4ad"/><rect x="20" y="29" width="24" height="16" rx="8" fill="#f8edda"/><path d="M24 53v4m16-4v4" stroke="#b59a87" stroke-width="4" stroke-linecap="round"/>${face(32, 34, 12)}`],
    ["bud", `<path d="M17 47C3 30 19 12 47 13c7 25 1 41-15 41-6 0-11-2-15-7" fill="#a5c5a0"/><path d="M44 18c-8 0-15 4-19 9" stroke="#d4e3bc" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M20 48l-3 7m23-4 2 5" stroke="#7fa17e" stroke-width="4" stroke-linecap="round"/>${face(31, 34, 12)}`],
    ["flux", `<path d="M32 10l5 7-5 5-5-5z" fill="#a4a0ce"/><path d="M18 21l24-1 9 13-6 19-25 2-8-18z" fill="#bcbce7"/><path d="M22 25h15" stroke="#e0dff8" stroke-width="3" stroke-linecap="round"/><path d="M12 34l-5 4m44-4 6 4m-33 16-2 4m17-5 3 4" stroke="#8e8fbc" stroke-width="4" stroke-linecap="round"/>${face(32, 34, 14)}`],
    ["dune", `<path d="M12 43c0-8 5-9 8-16 3-8 6-14 14-14 9 0 13 8 15 17 2 7 7 10 5 17-2 8-13 7-21 7-10 0-21 0-21-11" fill="#dfbea3"/><path d="M26 20q5-5 10-2" stroke="#f3dec8" stroke-width="3" fill="none" stroke-linecap="round"/><ellipse cx="23" cy="53" rx="5" ry="3" fill="#bf9b82"/><ellipse cx="43" cy="53" rx="5" ry="3" fill="#bf9b82"/>${face(33, 35, 13, "happy")}`],
    ["luna", `<path d="M16 26c0-10 8-16 18-14l10 7-4 8z" fill="#839cbb"/><path d="M15 32c-1-9 6-14 17-14s18 5 17 14l-2 16c-1 6-7 8-15 8s-14-2-15-8z" fill="#b2c9df"/><path d="M18 29q14-7 28 0" stroke="#e1ecf2" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M23 55v3m18-3v3" stroke="#839cbb" stroke-width="4" stroke-linecap="round"/>${face(32, 35, 12)}`],
    ["ember", `<path d="M22 27c-1-11 7-11 7-21 12 5 8 12 15 16 7 6 8 13 4 20H19c-9-7-8-15 3-15" fill="#cf987e"/><path d="M18 36c0-9 5-15 14-15s15 6 15 15c0 13-7 20-15 20s-14-7-14-20" fill="#ebbaa0"/><path d="M27 24l3-8" stroke="#f6d7bb" stroke-width="3" stroke-linecap="round"/><path d="M24 55v3m16-3v3" stroke="#b98570" stroke-width="4" stroke-linecap="round"/>${face(32, 36, 11)}`],
    ["dew", `<path d="M32 9c-5 9-19 19-19 30 0 10 8 17 19 17s19-7 19-17C51 28 37 18 32 9" fill="#91c1ca"/><path d="M21 31c-3 5-4 9-2 13" stroke="#cfe6e6" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M24 55l-2 3m18-3 2 3" stroke="#73a2af" stroke-width="4" stroke-linecap="round"/>${face(33, 37, 12, "happy")}`],
    ["mote", `<path d="M19 21l-4-7m30 7 4-7" stroke="#9e86b3" stroke-width="3" stroke-linecap="round"/><circle cx="13" cy="12" r="3.5" fill="#c6afd9"/><circle cx="51" cy="12" r="3.5" fill="#c6afd9"/><path d="M14 36c0-13 8-20 18-20s18 7 18 20c0 5-2 12-4 17l-9-3-5 5-5-5-9 3c-2-5-4-12-4-17" fill="#ccb7df"/><path d="M20 27q3-4 7-4" stroke="#e9ddf1" stroke-width="3" fill="none" stroke-linecap="round"/>${face(32, 34, 13)}`],
    ["lumen", `<path d="M13 31c0-12 9-20 19-20s19 8 19 20c0 9-8 12-9 20H22c-1-8-9-11-9-20" fill="#dfcc94"/><path d="M22 23q5-7 12-6" stroke="#f4e9bd" stroke-width="3" fill="none" stroke-linecap="round"/><rect x="23" y="48" width="18" height="6" rx="3" fill="#b9a475"/><path d="M27 57h10" stroke="#b9a475" stroke-width="3" stroke-linecap="round"/>${face(32, 31, 13, "happy")}`],
  ];
  const presets = Object.freeze(drawings.map(([id]) => Object.freeze({ id })));
  const shapes = new Map(drawings);
  const isPreset = value => typeof value === "string" && shapes.has(value);
  function defaultFor(name) {
    let hash = 0;
    for (const char of String(name || "default")) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    return presets[hash % presets.length].id;
  }
  function resolve(bot) {
    if (isPreset(bot.avatarPreset)) return { kind: "preset", id: bot.avatarPreset };
    return bot.hasAvatar ? { kind: "custom" } : { kind: "preset", id: defaultFor(bot.name) };
  }
  function svg(value) {
    const id = isPreset(value) ? value : presets[0].id;
    return `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">${shapes.get(id)}</svg>`;
  }
  function paint(node, bot, data = null) {
    const choice = resolve(bot), custom = choice.kind === "custom" && !!data;
    node.classList.toggle("has-picture", custom);
    node.setAttribute("aria-hidden", "true");
    node.replaceChildren();
    if (custom) {
      const img = node.ownerDocument.createElement("img");
      img.alt = ""; img.src = data; node.append(img);
      delete node.dataset.avatarPreset;
    } else {
      const id = choice.id || defaultFor(bot.name);
      node.dataset.avatarPreset = id;
      node.innerHTML = svg(id);
    }
    return node;
  }
  return Object.freeze({ presets, isPreset, defaultFor, resolve, svg, paint });
});
