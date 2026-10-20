"use strict";
// Messages waiting for the agent, as a stack of chips directly above the
// message box (the Host keeps them: server/composer-queue.js). The first one
// goes when the agent's turn ends. A chip sends its message into the turn
// under way, goes back into the box to be edited, or is removed. Chips rise
// out of the box as they are queued and leave upward, into the conversation,
// as the agent takes them.
(function () {
  const SVG = "http://www.w3.org/2000/svg";
  const GLYPHS = {
    // An arrow rising into a line: into the turn under way.
    send: "M6 4.75h12M12 19.25V8.75M7.75 12.75 12 8.5l4.25 4.25",
    edit: "M4.75 19.25l3.6-.75 9.9-9.9a1.8 1.8 0 0 0 0-2.55l-.3-.3a1.8 1.8 0 0 0-2.55 0l-9.9 9.9-.75 3.6zM13.5 7.25l3.25 3.25",
    remove: "M7.25 7.25l9.5 9.5M16.75 7.25l-9.5 9.5",
    clock: "M12 7.75V12l2.75 1.75M12 19.25a7.25 7.25 0 1 0 0-14.5 7.25 7.25 0 0 0 0 14.5z",
    alert: "M12 8.25v4.5M12 15.9v.1M12 19.25a7.25 7.25 0 1 0 0-14.5 7.25 7.25 0 0 0 0 14.5z",
    image: "M5.75 5.25h12.5a1.5 1.5 0 0 1 1.5 1.5v10.5a1.5 1.5 0 0 1-1.5 1.5H5.75a1.5 1.5 0 0 1-1.5-1.5V6.75a1.5 1.5 0 0 1 1.5-1.5zM4.25 15.5l4.25-4.25 3.5 3.5 2.75-2.75 5 5",
    more: "M6.5 12h.01M12 12h.01M17.5 12h.01",
  };
  function glyph(name) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("class", "cq-glyph");
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", GLYPHS[name]);
    svg.appendChild(path);
    return svg;
  }
  const oneLine = text => String(text || "").replace(/\s+/g, " ").trim();
  const reducedMotion = () => document.documentElement.classList.contains("reduced-motion") || !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  function animate(node, frames, options) {
    try { if (typeof node.animate === "function") return node.animate(frames, options).finished.catch(() => {}); } catch {}
    return Promise.resolve();
  }

  /**
   * root holds .cq-head (.cq-head-text, .cq-resume), .cq-list and .cq-live;
   * t(key, vars) gives its words. onSendNow, onEdit and onRemove act on a
   * chip's message; onResume lets a paused queue go on; onDelivered hears
   * each message the agent took; onEmpty takes the focus when the last chip
   * a person was on leaves.
   */
  function create({ root, t, onSendNow, onEdit, onRemove, onResume, onDelivered = () => {}, onEmpty = () => {} }) {
    const list = root.querySelector(".cq-list"), head = root.querySelector(".cq-head");
    const headText = root.querySelector(".cq-head-text"), resume = root.querySelector(".cq-resume"), live = root.querySelector(".cq-live");
    let chips = new Map(), shown = null, busy = false, canJump = true, focusFrom = null, reported = new Set(), menuOpen = null;
    resume.addEventListener("click", () => onResume?.());
    // A narrow stack gives the text its room: Edit and Remove move into a menu.
    function closeMenu(focusButton = false) {
      const chip = menuOpen;
      if (!chip) return;
      menuOpen = null;
      chip.menu.hidden = true; chip.more.setAttribute("aria-expanded", "false");
      if (focusButton) chip.more.focus({ preventScroll: true });
    }
    function openMenu(chip) {
      if (menuOpen && menuOpen !== chip) closeMenu();
      menuOpen = chip;
      chip.menu.hidden = false; chip.more.setAttribute("aria-expanded", "true");
      chip.menu.querySelector("[role=menuitem]")?.focus({ preventScroll: true });
    }
    document.addEventListener("click", event => {
      if (menuOpen && !(event.target instanceof Node && menuOpen.node.querySelector(".cq-actions").contains(event.target))) closeMenu();
    });
    // Controls that float above the box (jump to latest) keep above the stack.
    const measure = () => {
      const height = root.hidden ? 0 : root.getBoundingClientRect().height + (parseFloat(getComputedStyle(root).marginBottom) || 0);
      root.parentElement?.style.setProperty("--composer-queue-h", `${Math.round(height)}px`);
    };
    if (typeof ResizeObserver === "function") new ResizeObserver(measure).observe(root);

    function say(text) {
      // The same words twice in a row are still announced.
      live.textContent = "";
      requestAnimationFrame(() => { live.textContent = text; });
    }
    function button(kind) {
      const node = document.createElement("button");
      node.type = "button"; node.className = `cq-btn cq-${kind}`;
      node.appendChild(glyph(kind));
      if (kind === "send") node.appendChild(Object.assign(document.createElement("span"), { className: "cq-label" }));
      return node;
    }
    function build(item) {
      const node = document.createElement("li");
      node.className = "cq-chip";
      const mark = Object.assign(document.createElement("span"), { className: "cq-mark" });
      mark.setAttribute("aria-hidden", "true");
      const body = Object.assign(document.createElement("span"), { className: "cq-body" });
      const text = Object.assign(document.createElement("span"), { className: "cq-text" });
      const meta = Object.assign(document.createElement("span"), { className: "cq-meta" });
      body.append(text, meta);
      const images = Object.assign(document.createElement("span"), { className: "cq-images" });
      images.append(glyph("image"), document.createElement("span"));
      const actions = Object.assign(document.createElement("span"), { className: "cq-actions" });
      const menu = Object.assign(document.createElement("span"), { className: "cq-menu", hidden: true });
      menu.setAttribute("role", "menu");
      const menuItem = kind => {
        const entry = Object.assign(document.createElement("button"), { type: "button", className: `cq-menu-item cq-menu-${kind}` });
        entry.setAttribute("role", "menuitem"); entry.tabIndex = -1;
        entry.append(glyph(kind), document.createElement("span"));
        return entry;
      };
      const chip = { node, item, mark, text, meta, images, send: button("send"), edit: button("edit"), remove: button("remove"), more: button("more"),
        menu, menuEdit: menuItem("edit"), menuRemove: menuItem("remove"), markKind: "" };
      chip.more.setAttribute("aria-haspopup", "menu"); chip.more.setAttribute("aria-expanded", "false");
      menu.append(chip.menuEdit, chip.menuRemove);
      actions.append(chip.send, chip.edit, chip.remove, chip.more, menu);
      node.append(mark, body, images, actions);
      const edit = () => { closeMenu(); if (!chip.edit.disabled) onEdit?.(chip.item); };
      const remove = () => { closeMenu(); if (!chip.remove.disabled) { focusFrom = chip.item.id; onRemove?.(chip.item); } };
      chip.send.addEventListener("click", () => { if (!chip.send.disabled) { focusFrom = chip.item.id; onSendNow?.(chip.item); } });
      chip.edit.addEventListener("click", edit); chip.menuEdit.addEventListener("click", edit);
      chip.remove.addEventListener("click", remove); chip.menuRemove.addEventListener("click", remove);
      chip.more.addEventListener("click", event => { event.stopPropagation(); if (menuOpen === chip) closeMenu(); else if (!chip.more.disabled) openMenu(chip); });
      menu.addEventListener("keydown", event => {
        const entries = [...menu.querySelectorAll("[role=menuitem]:not(:disabled)")], index = entries.indexOf(document.activeElement);
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
        else if (event.key === "Tab") closeMenu();
        else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          entries[event.key === "ArrowDown" ? (index + 1) % entries.length : (index <= 0 ? entries.length - 1 : index - 1)]?.focus({ preventScroll: true });
        }
      });
      return chip;
    }
    function paint(chip, item) {
      chip.item = item;
      const { node } = chip, waiting = ["queued", "failed", "attention"].includes(item.state);
      const preview = oneLine(item.text) + (item.truncated ? "…" : ""), shownText = preview || t("queue.imagesOnly");
      node.dataset.id = item.id; node.dataset.state = item.state; node.dataset.stage = item.stage || "";
      chip.text.textContent = shownText; chip.text.title = preview;
      const imageLabel = item.imageCount ? t(item.imageCount === 1 ? "queue.imageOne" : "queue.images", { count: item.imageCount }) : "";
      chip.images.hidden = !item.imageCount;
      chip.images.lastChild.textContent = item.imageCount ? String(item.imageCount) : "";
      chip.images.title = imageLabel;
      // What the chip is doing, in words beside its preview.
      const status = item.state === "dispatching" ? t(item.stage === "accepted" || item.stage === "native" ? "queue.joining" : "queue.sending")
        : item.state === "attention" ? t("queue.attention") : item.state === "failed" ? t("queue.failed")
          : item.error === "jump_unavailable" ? t("queue.jumpUnavailable") : "";
      chip.meta.textContent = status; chip.meta.hidden = !status;
      const kind = item.state === "attention" || item.state === "failed" ? "alert" : item.state === "dispatching" ? "busy" : "clock";
      if (kind !== chip.markKind) {
        chip.markKind = kind;
        chip.mark.replaceChildren(kind === "busy" ? Object.assign(document.createElement("span"), { className: "cq-spinner" }) : glyph(kind));
      }
      // Into the turn under way while the agent works; at once when it is idle.
      const blocked = busy && !canJump;
      const label = item.state === "attention" ? t("queue.sendAgain") : busy ? t("queue.sendNow") : t("queue.sendIdle");
      chip.send.querySelector(".cq-label").textContent = label;
      chip.send.setAttribute("aria-label", `${label}: ${shownText}`);
      chip.send.title = blocked ? t("queue.jumpUnavailable") : item.state === "attention" ? t("queue.sendAgainHint") : busy ? t("queue.sendNowHint") : t("queue.sendIdleHint");
      chip.edit.setAttribute("aria-label", `${t("queue.edit")}: ${shownText}`); chip.edit.title = t("queue.editHint");
      chip.remove.setAttribute("aria-label", `${t("queue.remove")}: ${shownText}`); chip.remove.title = t("queue.remove");
      chip.more.setAttribute("aria-label", `${t("queue.more")}: ${shownText}`); chip.more.title = t("queue.more");
      chip.menuEdit.lastChild.textContent = t("queue.edit"); chip.menuRemove.lastChild.textContent = t("queue.remove");
      chip.send.disabled = !waiting || blocked;
      chip.edit.disabled = chip.remove.disabled = chip.more.disabled = chip.menuEdit.disabled = chip.menuRemove.disabled = !waiting;
      if (!waiting && menuOpen === chip) closeMenu();
      node.setAttribute("aria-label", [shownText, imageLabel, status].filter(Boolean).join(" · "));
    }
    function focusAfter(id, order) {
      const index = order.indexOf(id);
      const next = chips.get(order.slice(index + 1).find(other => chips.has(other))) || chips.get(order.slice(0, Math.max(0, index)).reverse().find(other => chips.has(other)));
      if (next) (next.send.disabled ? next.remove : next.send).focus({ preventScroll: true });
      else onEmpty();
    }
    async function leave(chip, how, order) {
      const { node } = chip, id = chip.item.id;
      if (menuOpen === chip) closeMenu();
      if (node.contains(document.activeElement) || focusFrom === id) { focusFrom = null; focusAfter(id, order); }
      node.classList.add("cq-leaving"); node.inert = true;
      if (reducedMotion()) await animate(node, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: "linear", fill: "forwards" });
      else {
        // Delivered, it goes up into the conversation; removed, it just goes.
        const away = how === "delivered" ? "translateY(-14px) scale(.98)" : "scale(.96)";
        await animate(node, [{ opacity: 1, transform: "none", filter: "blur(0)" }, { opacity: 0, transform: away, filter: "blur(2px)" }],
          { duration: how === "delivered" ? 260 : 180, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "forwards" });
        const height = node.getBoundingClientRect().height;
        await animate(node, [{ height: `${height}px` }, { height: "0px", marginTop: `-${parseFloat(getComputedStyle(list).rowGap) || 0}px` }],
          { duration: 170, easing: "cubic-bezier(.2, .8, .2, 1)", fill: "forwards" });
      }
      node.remove();
      sync();
    }
    function enter(node) {
      if (reducedMotion()) { void animate(node, [{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: "linear" }); return; }
      // Out of the message box: a short rise, the material arriving as it goes.
      void animate(node, [{ opacity: 0, transform: "translateY(10px) scale(.97)", filter: "blur(3px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }],
        { duration: 280, easing: "cubic-bezier(.2, .9, .25, 1)" });
    }
    function sync() {
      root.hidden = chips.size === 0 && !list.querySelector(".cq-leaving");
      head.hidden = !(shown?.paused && chips.size > 0);
      measure();
    }
    function reset() {
      menuOpen = null;
      chips = new Map(); list.replaceChildren(); shown = null; focusFrom = null; reported = new Set();
      sync();
    }

    function update(snapshot, state = {}) {
      if (!snapshot) { reset(); return; }
      busy = !!state.busy; canJump = snapshot.canJump !== false;
      const first = shown === null || shown.agent !== snapshot.agent || shown.id !== snapshot.id;
      if (first) { reset(); for (const row of snapshot.recent || []) reported.add(row.id); }
      // An older snapshot, read before a newer one arrived, changes nothing.
      if (!first && Number(snapshot.revision) < Number(shown.revision)) return;
      shown = snapshot;
      const items = Array.isArray(snapshot.items) ? snapshot.items : [];
      const order = [...chips.keys()], present = new Set(items.map(item => item.id)), next = new Map();
      // A message delivered while this page did not hold its chip still shows
      // in the conversation; each is reported once.
      for (const row of snapshot.recent || []) {
        if (row.state !== "delivered" || reported.has(row.id)) continue;
        reported.add(row.id);
        try { onDelivered(row); } catch {}
      }
      let previous = null;
      for (const item of items) {
        let chip = chips.get(item.id);
        if (!chip) {
          chip = build(item);
          if (!first) say(t("queue.announceQueued", { text: oneLine(item.text).slice(0, 120) || t("queue.imagesOnly") }));
        }
        next.set(item.id, chip);
        const after = previous ? previous.nextSibling : list.firstChild;
        if (chip.node !== after) list.insertBefore(chip.node, after);
        if (!chips.has(item.id) && !first) enter(chip.node);
        paint(chip, item);
        previous = chip.node;
      }
      const leaving = [...chips.values()].filter(chip => !present.has(chip.item.id));
      chips = next;
      for (const chip of leaving) {
        const recent = (snapshot.recent || []).find(row => row.id === chip.item.id);
        if (recent?.state === "delivered") say(t("queue.announceDelivered", { text: oneLine(chip.item.text).slice(0, 120) || t("queue.imagesOnly") }));
        else if (recent?.state === "removed") say(t("queue.announceRemoved"));
        void leave(chip, recent?.state === "delivered" ? "delivered" : "removed", order);
      }
      headText.textContent = snapshot.paused ? t(snapshot.pauseReason === "failed" ? "queue.pausedFailed" : snapshot.pauseReason === "restart" ? "queue.pausedRestart" : "queue.pausedStopped") : "";
      resume.textContent = t("queue.resume");
      root.setAttribute("aria-label", t("queue.title"));
      sync();
    }
    return Object.freeze({
      update,
      reset,
      /** Words again in another language, or the agent started or stopped working. */
      refresh(state = {}) { if (shown) update(shown, { busy: state.busy ?? busy }); },
      get size() { return chips.size; },
      items() { return [...chips.values()].map(chip => chip.item); },
    });
  }

  window.StepsembleComposerQueue = Object.freeze({ create });
  if (typeof module === "object" && module.exports) module.exports = { create };
})();
