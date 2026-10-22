/* IME-safe Enter handling shared by the browser and deterministic tests. */
(function exposeStepsembleComposerIme(root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.stepsembleComposerIme = Object.freeze(api);
})(typeof window !== "undefined" ? window : null, (root) => {
  "use strict";

  // Older WebKit can send the committing keydown after compositionend,
  // with isComposing false but keyCode 229 (WebKit bug 165004). The Mac app
  // and Safari are WebKit. Inspect the key itself rather than blocking the
  // next Enter for a time window: the composition may have ended via Space,
  // a candidate click or dictation.
  // https://bugs.webkit.org/show_bug.cgi?id=165004
  const fromInputMethod = (event, composing) => composing || event.isComposing === true || event.keyCode === 229 || event.which === 229;

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

    function classifyEnter(event) {
      if (!event || event.key !== "Enter") return { ime: false, preventDefault: false };
      if (fromInputMethod(event, active)) return { ime: true, preventDefault: false };
      return { ime: false, preventDefault: false };
    }

    return Object.freeze({ compositionStart, compositionEnd, blur, classifyEnter });
  }

  // Every other text field: Enter acts only when no input method used it to
  // confirm text (Chinese, Japanese or Korean, or English typed through one).
  // Read the Enter key only through isEnter; test/ime-enter.test.js holds
  // the page code to it.
  let composing = false;
  const page = root && root.document;
  if (page && typeof page.addEventListener === "function") {
    page.addEventListener("compositionstart", () => { composing = true; }, true);
    page.addEventListener("compositionend", () => { composing = false; }, true);
    page.addEventListener("focusout", () => { composing = false; }, true);
  }
  function isImeEnter(event) {
    return !!event && event.key === "Enter" && fromInputMethod(event, composing);
  }
  function isEnter(event) {
    return !!event && event.key === "Enter" && !fromInputMethod(event, composing);
  }

  return Object.freeze({ createGuard, isEnter, isImeEnter });
});
