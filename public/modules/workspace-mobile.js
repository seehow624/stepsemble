/* Phones keep the original single-column conversation app. The split-pane
   shell is a desktop layout, so a narrow viewport leaves for /index.html
   before the shell paints. `?shell=1` opts a narrow window back in, and an
   embedded pane frame is never redirected. */
"use strict";
(() => {
  if (window.top !== window.self) return;
  try {
    if (new URLSearchParams(location.search).get("shell") === "1") return;
    if (!matchMedia("(max-width: 760px)").matches) return;
  } catch { return; }
  location.replace(new URL("/index.html", location.origin).href);
})();
