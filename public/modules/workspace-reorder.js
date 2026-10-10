/* Pointer capture gives mouse and touch the same sidebar ordering gesture. */
(function (root) {
  "use strict";
  let cancel = () => {};
  function attach(handle, source, { kind, id, group = "", pinned, move, started, ended, keyboard }) {
    Object.assign(source.dataset, { reorderKind: kind, reorderId: id, reorderGroup: group, pinned: String(pinned) });
    handle.onkeydown = event => {
      if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault(); keyboard(event.key === "ArrowUp" ? -1 : 1);
    };
    handle.onpointerdown = event => {
      if (event.button !== 0 || handle.disabled) return;
      cancel(); event.preventDefault(); event.stopPropagation();
      const origin = [event.clientX, event.clientY], grab = source.querySelector("header") || source;
      const bounds = grab.getBoundingClientRect(), scroller = source.closest("#workspace-projects");
      let ghost = null, marker = null, active = false, before = id, frame = 0, point = origin;
      const peers = () => [...scroller.querySelectorAll("[data-reorder-kind]")].filter(node => node.dataset.reorderKind === kind && node.dataset.reorderGroup === group && node.dataset.pinned === String(pinned));
      const update = () => {
        ghost.style.transform = `translate(${point[0] - origin[0]}px,${point[1] - origin[1]}px)`;
        const hit = document.elementsFromPoint(...point).map(node => node.closest?.(`[data-reorder-kind="${kind}"]`))
          .find(node => node && peers().includes(node));
        if (!hit || hit === source) { before = id; marker.hidden = true; return; }
        const rows = peers(), rect = hit.getBoundingClientRect();
        const height = kind === "project" ? hit.querySelector("header").getBoundingClientRect().height : rect.height;
        const after = point[1] >= rect.top + height / 2;
        before = after ? rows[rows.indexOf(hit) + 1]?.dataset.reorderId || null : hit.dataset.reorderId;
        if (before === id) { marker.hidden = true; return; }
        marker.style.left = `${rect.left}px`; marker.style.width = `${rect.width}px`;
        marker.style.top = `${after ? rect.bottom : rect.top}px`; marker.hidden = false;
      };
      const scroll = () => {
        if (!active) return;
        const rect = scroller.getBoundingClientRect();
        const speed = point[1] < rect.top + 36 ? -Math.min(14, (rect.top + 36 - point[1]) / 3)
          : point[1] > rect.bottom - 36 ? Math.min(14, (point[1] - rect.bottom + 36) / 3) : 0;
        if (speed) { scroller.scrollTop += speed; update(); }
        frame = requestAnimationFrame(scroll);
      };
      const moving = next => {
        if (next.pointerId !== event.pointerId) return;
        point = [next.clientX, next.clientY];
        if (!active && Math.hypot(point[0] - origin[0], point[1] - origin[1]) < 8) return;
        next.preventDefault();
        if (!active) {
          active = true; started(); source.classList.add("workspace-reorder-source");
          ghost = grab.cloneNode(true); ghost.className = "workspace-reorder-ghost"; ghost.setAttribute("aria-hidden", "true");
          Object.assign(ghost.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
          marker = document.createElement("div"); marker.className = "workspace-reorder-marker"; marker.hidden = true;
          document.body.append(ghost, marker); frame = requestAnimationFrame(scroll);
        }
        update();
      };
      const finish = commit => {
        cancelAnimationFrame(frame); ghost?.remove(); marker?.remove(); source.classList.remove("workspace-reorder-source");
        handle.removeEventListener("pointermove", moving); handle.removeEventListener("pointerup", released);
        handle.removeEventListener("pointercancel", aborted); handle.removeEventListener("lostpointercapture", aborted);
        document.removeEventListener("keydown", escape);
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        cancel = () => {};
        if (active) { ended(); if (commit && before !== id) move(before); }
      };
      const released = next => { if (next.pointerId === event.pointerId) { if (active) { point = [next.clientX, next.clientY]; update(); } finish(true); } };
      const aborted = () => finish(false);
      const escape = next => { if (next.key === "Escape") { next.preventDefault(); finish(false); } };
      cancel = aborted; handle.setPointerCapture(event.pointerId);
      handle.addEventListener("pointermove", moving); handle.addEventListener("pointerup", released);
      handle.addEventListener("pointercancel", aborted); handle.addEventListener("lostpointercapture", aborted);
      document.addEventListener("keydown", escape);
    };
  }
  root.StepsembleWorkspaceReorder = { attach, cancel: () => cancel() };
})(window);
