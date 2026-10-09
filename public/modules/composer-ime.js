/* IME-safe Enter handling shared by the browser and deterministic tests. */
(function exposeStepsembleComposerIme(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.stepsembleComposerIme = Object.freeze(api);
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";

  function createGuard() {
    let active = false;

    function compositionStart() {
      active = true;
    }

    function compositionEnd() {
      active = false;
    }

    function blur() {
      active = false;
    }

    // Older WebKit can send the committing keydown after compositionend,
    // with isComposing false but keyCode 229 (WebKit bug 165004). Inspect the
    // key itself rather than blocking the next Enter for a time window: the
    // composition may have ended via Space, a candidate click or dictation.
    // https://bugs.webkit.org/show_bug.cgi?id=165004
    function classifyEnter(event) {
      if (!event || event.key !== "Enter") return { ime: false, preventDefault: false };
      if (active || event.isComposing === true || event.keyCode === 229 || event.which === 229) {
        return { ime: true, preventDefault: false };
      }
      return { ime: false, preventDefault: false };
    }

    return Object.freeze({ compositionStart, compositionEnd, blur, classifyEnter });
  }

  return Object.freeze({ createGuard });
});
