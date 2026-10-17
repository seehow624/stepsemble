(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.StepsembleAssistantAvatars = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  // 46 款毛絨頭像，分成 A–Z 字母、個性角色與元素精靈三類。圖檔是由 1254px 原圖
  // 縮成的 256px 透明 WebP；換圖時改用新的版本資料夾，避免讀到快取的舊圖。
  const BASE = "/assistant-avatars/v1/";
  const LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
  const CHARACTERS = ["Atlas", "Pixel", "Nova", "Bolt", "Echo", "Orbit", "Muse", "Prism", "Buzz", "Ledger"];
  const ELEMENTS = ["metal", "wood", "water", "fire", "earth", "wind", "thunder", "ice", "light", "shadow"];
  const preset = (group, prefix, name) => Object.freeze({ id: `${prefix}-${name.toLowerCase()}`, group, name });
  const groups = Object.freeze([
    Object.freeze({ id: "letters", presets: Object.freeze(LETTERS.map(name => preset("letters", "letter", name))) }),
    Object.freeze({ id: "characters", presets: Object.freeze(CHARACTERS.map(name => preset("characters", "character", name))) }),
    Object.freeze({ id: "elements", presets: Object.freeze(ELEMENTS.map(name => preset("elements", "element", name))) }),
  ]);
  const presets = Object.freeze(groups.flatMap(group => group.presets));
  const ids = new Set(presets.map(item => item.id));
  const figures = presets.filter(item => item.group !== "letters");
  const isPreset = value => typeof value === "string" && ids.has(value);
  const url = value => isPreset(value) ? `${BASE}${value}.webp` : null;

  // 沒選頭像時：名稱以英文字母開頭就用那個字母（去掉重音符號），
  // 其他名稱依設定檔 ID 固定配一款角色或元素精靈。
  function defaultFor(bot) {
    const named = typeof bot === "string" ? { name: bot } : bot || {};
    const label = String(named.displayName || named.name || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
    if (/^[A-Za-z]/.test(label)) return `letter-${label[0].toLowerCase()}`;
    let hash = 0;
    for (const char of String(named.name || label || "default")) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    return figures[hash % figures.length].id;
  }
  function resolve(bot) {
    if (isPreset(bot.avatarPreset)) return { kind: "preset", id: bot.avatarPreset };
    return bot.hasAvatar ? { kind: "custom" } : { kind: "preset", id: defaultFor(bot) };
  }
  // 上傳的圖片還沒讀到時，先顯示預設頭像。
  function paint(node, bot, data = null, { lazy = false } = {}) {
    const choice = resolve(bot), custom = choice.kind === "custom" && !!data;
    const img = node.ownerDocument.createElement("img");
    img.alt = ""; img.decoding = "async"; img.draggable = false;
    if (lazy) img.loading = "lazy";
    node.classList.toggle("has-picture", custom);
    node.setAttribute("aria-hidden", "true");
    if (custom) { img.src = data; delete node.dataset.avatarPreset; }
    else {
      const id = choice.id || defaultFor(bot);
      node.dataset.avatarPreset = id; img.src = url(id);
    }
    node.replaceChildren(img);
    return node;
  }
  return Object.freeze({ groups, presets, isPreset, url, defaultFor, resolve, paint });
});
