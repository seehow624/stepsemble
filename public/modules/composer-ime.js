/* IME-safe Enter handling shared by the browser and deterministic tests. */
(function exposeStepsembleComposerIme(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.stepsembleComposerIme = Object.freeze(api);
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";

  function createGuard({ now = () => globalThis.performance?.now?.() ?? Date.now(), graceMs = 180 } = {}) {
    let active = false;
    let commitUntil = 0;
    let composingEnterSeen = false;

    function compositionStart() {
      active = true;
      commitUntil = 0;
      composingEnterSeen = false;
    }

    function compositionEnd() {
      active = false;
      // Chrome dispatches the committing keydown before compositionend, while
      // Safari can dispatch it after. Arm the short latch only when no Enter
      // was already observed during this composition.
      commitUntil = composingEnterSeen ? 0 : Number(now()) + Math.max(0, Number(graceMs) || 0);
      composingEnterSeen = false;
    }

    function blur() {
      active = false;
      commitUntil = 0;
      composingEnterSeen = false;
    }

    // Safari/macOS can dispatch compositionend before the keydown belonging
    // to the same Enter. `isComposing` is then already false. Consume exactly
    // that one Enter inside a short latch; the next Enter can submit normally.
    function classifyEnter(event) {
      if (!event || event.key !== "Enter") return { ime: false, preventDefault: false };
      if (active || event.isComposing === true || event.keyCode === 229 || event.which === 229) {
        if (active || event.isComposing === true) composingEnterSeen = true;
        commitUntil = 0;
        return { ime: true, preventDefault: false };
      }
      if (Number(now()) <= commitUntil && commitUntil > 0) {
        commitUntil = 0;
        return { ime: true, preventDefault: true };
      }
      return { ime: false, preventDefault: false };
    }

    return Object.freeze({ compositionStart, compositionEnd, blur, classifyEnter });
  }

  return Object.freeze({ createGuard });
});
