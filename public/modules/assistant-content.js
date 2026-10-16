(function (root) {
  "use strict";

  // 每個寬內容都有自己的捲動範圍，不讓表格或圖片撐開整個對話。
  function create({ document: doc = document, marked = root.marked, purify = root.DOMPurify } = {}) {
    function markdown(text) {
      const box = doc.createElement("div");
      box.className = "md-body";
      if (!marked || !purify) { box.textContent = text; return box; }
      box.innerHTML = purify.sanitize(marked.parse(text, { breaks: true, gfm: true }), { ADD_ATTR: ["target"] });
      for (const link of box.querySelectorAll("a[href]")) { link.target = "_blank"; link.rel = "noopener noreferrer"; }
      for (const table of box.querySelectorAll("table")) {
        const frame = doc.createElement("div");
        frame.className = "md-table";
        const scroll = doc.createElement("div");
        scroll.className = "md-table-scroll";
        scroll.tabIndex = 0;
        table.replaceWith(frame);
        frame.append(scroll);
        scroll.append(table);
        for (const cell of table.querySelectorAll("th, td")) {
          const content = doc.createElement("div");
          content.className = "md-cell";
          content.append(...cell.childNodes);
          cell.append(content);
        }
      }
      return box;
    }
    return Object.freeze({ markdown });
  }
  root.StepsembleAssistantContent = Object.freeze({ create });
})(window);
