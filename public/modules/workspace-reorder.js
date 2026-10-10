/* Whole-row native dragging; touch holds to reorder without taking over scrolling. */
(function (root) {
  "use strict";
  const HOLD_MS = 320, SLOP = 8;
  let cancel = () => {}, suppressClickUntil = 0;
  document.addEventListener("click", event => {
    if (Date.now() >= suppressClickUntil || event.detail === 0 || !event.target.closest?.("[data-reorder-surface]")) return;
    suppressClickUntil = 0; event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  function attach(surface, source, { kind, id, group = "", pinned, move, started, ended, keyboard, nativeStart, enabled = () => true }) {
    Object.assign(source.dataset, { reorderKind: kind, reorderId: id, reorderGroup: group, pinned: String(pinned) });
    surface.dataset.reorderSurface = "true"; surface.draggable = true;
    surface.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
    surface.onkeydown = event => {
      if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key) || !enabled()) return;
      event.preventDefault(); keyboard(event.key === "ArrowUp" ? -1 : 1);
    };
    let touch = null;
    function begin(event, native) {
      cancel();
      const origin = [event.clientX, event.clientY], grab = source.querySelector("header") || source;
      const bounds = grab.getBoundingClientRect(), scroller = source.closest("#workspace-projects");
      let ghost = null, marker = null, active = false, closed = false, before = id, frame = 0, timer = 0, point = origin;
      const peers = () => [...scroller.querySelectorAll("[data-reorder-kind]")].filter(node => node.dataset.reorderKind === kind && node.dataset.reorderGroup === group && node.dataset.pinned === String(pinned));
      const update = () => {
        if (ghost) ghost.style.transform = `translate(${point[0] - origin[0]}px,${point[1] - origin[1]}px)`;
        const rows = peers();
        const hit = document.elementsFromPoint(...point).map(node => node.closest?.(`[data-reorder-kind="${kind}"]`))
          .find(node => node && rows.includes(node));
        before = id; marker.hidden = true;
        if (!hit || hit === source) return !!hit;
        const rect = hit.getBoundingClientRect();
        const height = kind === "project" ? hit.querySelector("header").getBoundingClientRect().height : rect.height;
        const after = point[1] >= rect.top + height / 2;
        before = after ? rows[rows.indexOf(hit) + 1]?.dataset.reorderId || null : hit.dataset.reorderId;
        if (before !== id) {
          marker.style.left = `${rect.left}px`; marker.style.width = `${rect.width}px`;
          marker.style.top = `${after ? rect.bottom : rect.top}px`; marker.hidden = false;
        }
        return true;
      };
      const scroll = () => {
        if (!active) return;
        const rect = scroller.getBoundingClientRect();
        const inside = point[0] >= rect.left && point[0] <= rect.right;
        const speed = !inside ? 0 : point[1] < rect.top + 36 ? -Math.min(14, (rect.top + 36 - point[1]) / 3)
          : point[1] > rect.bottom - 36 ? Math.min(14, (point[1] - rect.bottom + 36) / 3) : 0;
        if (speed) { scroller.scrollTop += speed; update(); }
        frame = requestAnimationFrame(scroll);
      };
      const activate = () => {
        if (closed || surface.isConnected === false || !enabled()) { finish(false); return; }
        active = true; started(); source.classList.add("workspace-reorder-source");
        marker = document.createElement("div"); marker.className = "workspace-reorder-marker"; marker.hidden = true;
        if (!native) {
          ghost = grab.cloneNode(true); ghost.className = "workspace-reorder-ghost"; ghost.setAttribute("aria-hidden", "true");
          Object.assign(ghost.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
          document.body.append(ghost); surface.setPointerCapture(event.pointerId);
        }
        document.body.append(marker); frame = requestAnimationFrame(scroll);
      };
      const moving = next => {
        if (next.pointerId !== event.pointerId) return;
        point = [next.clientX, next.clientY];
        if (!active) {
          if (Math.hypot(point[0] - origin[0], point[1] - origin[1]) >= SLOP) finish(false);
          return;
        }
        next.preventDefault(); update();
      };
      const touchMove = next => {
        if (next.touches.length > 1) { finish(false); return; }
        if (active) next.preventDefault();
      };
      const touchEnd = next => { if (active) next.preventDefault(); };
      const contextMenu = next => { next.preventDefault(); next.stopImmediatePropagation(); };
      const nativeMove = next => {
        point = [next.clientX, next.clientY];
        if (update()) { next.preventDefault(); next.dataTransfer.dropEffect = "move"; }
      };
      const nativeDrop = next => {
        point = [next.clientX, next.clientY];
        const inside = update(); if (inside) next.preventDefault(); finish(inside);
      };
      const finish = commit => {
        if (closed) return; closed = true;
        clearTimeout(timer); cancelAnimationFrame(frame); ghost?.remove(); marker?.remove(); source.classList.remove("workspace-reorder-source");
        document.removeEventListener("pointermove", moving); document.removeEventListener("pointerup", released);
        document.removeEventListener("pointercancel", aborted); document.removeEventListener("touchmove", touchMove);
        document.removeEventListener("touchend", touchEnd); document.removeEventListener("contextmenu", contextMenu, true);
        document.removeEventListener("dragover", nativeMove); document.removeEventListener("drop", nativeDrop);
        surface.removeEventListener("dragend", aborted); surface.removeEventListener("lostpointercapture", aborted);
        document.removeEventListener("keydown", escape);
        if (!native && surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
        cancel = () => {}; touch = null;
        if (active) {
          if (!native) suppressClickUntil = Date.now() + 400;
          ended(native); if (commit && before !== id) move(before);
        }
      };
      const released = next => {
        if (next.pointerId !== event.pointerId) return;
        if (active) { next.preventDefault(); point = [next.clientX, next.clientY]; update(); }
        finish(true);
      };
      const aborted = () => finish(false);
      const escape = next => { if (next.key === "Escape") { next.preventDefault(); finish(false); } };
      cancel = aborted; document.addEventListener("keydown", escape);
      if (native) {
        activate();
        if (closed) return false;
        document.addEventListener("dragover", nativeMove); document.addEventListener("drop", nativeDrop); surface.addEventListener("dragend", aborted);
      } else {
        touch = { cancel: aborted };
        document.addEventListener("pointermove", moving); document.addEventListener("pointerup", released); document.addEventListener("pointercancel", aborted);
        document.addEventListener("touchmove", touchMove, { passive: false }); document.addEventListener("touchend", touchEnd, { passive: false });
        document.addEventListener("contextmenu", contextMenu, true); surface.addEventListener("lostpointercapture", aborted);
        timer = setTimeout(activate, HOLD_MS);
      }
      return true;
    }
    surface.onpointerdown = event => {
      if (event.pointerType === "touch" && event.isPrimary === false) { cancel(); return; }
      // A new press is intentional; only the compatibility click from the
      // completed hold belongs to the drag we are suppressing.
      suppressClickUntil = 0;
      if (event.pointerType !== "touch" || event.button !== 0 || surface.disabled || !enabled()) return;
      begin(event, false);
    };
    surface.ondragstart = event => {
      if (touch || surface.disabled || !enabled()) { event.preventDefault(); return; }
      if (!begin(event, true)) { event.preventDefault(); return; }
      event.dataTransfer.setData("application/x-stepsemble-reorder", JSON.stringify({ kind, id, group, pinned }));
      event.dataTransfer.effectAllowed = "move";
      nativeStart?.(event);
    };
  }
  root.StepsembleWorkspaceReorder = { attach, cancel: () => cancel() };
})(window);
