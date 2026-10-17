(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.StepsembleAssistantAvatars = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  // 換圖時改用新的版本資料夾，避免讀到快取的舊圖。
  const BASE = "/assistant-avatars/v1/";
  const ABSTRACT = ["Void", "Mercury", "Fold", "Orbit", "Prism", "Ink", "Bloom", "Echo"];
  const LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
  const CHARACTERS = ["Atlas", "Pixel", "Nova", "Bolt", "Echo", "Orbit", "Muse", "Prism", "Buzz", "Ledger"];
  const ELEMENTS = ["metal", "wood", "water", "fire", "earth", "wind", "thunder", "ice", "light", "shadow"];
  const preset = (group, prefix, name) => Object.freeze({ id: `${prefix}-${name.toLowerCase()}`, group, name });
  const groups = Object.freeze([
    Object.freeze({ id: "abstract", presets: Object.freeze(ABSTRACT.map(name => preset("abstract", "abstract", name))) }),
    Object.freeze({ id: "letters", presets: Object.freeze(LETTERS.map(name => preset("letters", "letter", name))) }),
    Object.freeze({ id: "characters", presets: Object.freeze(CHARACTERS.map(name => preset("characters", "character", name))) }),
    Object.freeze({ id: "elements", presets: Object.freeze(ELEMENTS.map(name => preset("elements", "element", name))) }),
  ]);
  const presets = Object.freeze(groups.flatMap(group => group.presets));
  const ids = new Set(presets.map(item => item.id));
  const isPreset = value => typeof value === "string" && ids.has(value);
  const url = value => isPreset(value) ? `${BASE}${value}.webp` : null;

  function defaultFor(bot) {
    const index = Number.isSafeInteger(bot?.avatarIndex) && bot.avatarIndex >= 0 ? bot.avatarIndex : 0;
    return groups[0].presets[index % ABSTRACT.length].id;
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
