(function () {
  "use strict";
  const view = window.stepsembleProjectFileView;
  function create({ api, context, text, onModeChange }) {
    const $ = id => document.getElementById(id);
    const layer = $("changes-layer"), body = $("project-browser"), tabs = $("project-file-tabs");
    const git = layer.querySelector(".changes-content");
    let mode = "modified", turn = null, folder = "", listing = null, listingError = null, filter = "", hidden = false;
    let selected = "", preview = null, previewError = null, directoryRequest = null, fileRequest = null;
    const node = (tag, cls, copy) => {
      const element = document.createElement(tag); if (cls) element.className = cls;
      if (copy !== undefined) element.textContent = copy; return element;
    };
    const icon = name => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.classList.add("icon"); svg.setAttribute("aria-hidden", "true");
      const use = document.createElementNS(svg.namespaceURI, "use"); use.setAttribute("href", "#i-" + name); svg.append(use); return svg;
    };
    function button(cls, label, action, glyph) {
      const element = node("button", cls); element.type = "button"; element.title = label; element.setAttribute("aria-label", label);
      if (glyph) element.append(icon(glyph)); else element.textContent = label;
      element.addEventListener("click", action); return element;
    }
    function notice(copy) { const element = node("p", "project-file-notice", copy); element.setAttribute("role", "status"); return element; }
    function errorText(error) {
      const key = String(error?.message || "");
      return text(["fileMissing", "permissionDenied", "outsideProject", "projectUnavailable", "fileChanged", "notTextFile"].includes(key) ? key : "fileUnavailable");
    }
    function numbers(file) {
      const span = node("span", "project-file-counts");
      span.append(node("span", "changes-additions", `+${file.added || 0}`), node("span", "changes-deletions", `−${file.removed || 0}`)); return span;
    }
    function abort() {
      directoryRequest?.controller.abort(); fileRequest?.controller.abort(); directoryRequest = null; fileRequest = null;
    }
    const key = () => JSON.stringify(context());
    function chrome() {
      const active = mode === "files" || !!turn;
      git.classList.toggle("hidden", active); body.classList.toggle("hidden", !active);
      layer.classList.toggle("project-browser-active", active);
      layer.classList.toggle("project-turn-review", mode === "modified" && !!turn);
      for (const tab of tabs.querySelectorAll("button")) {
        const isSelected = tab.dataset.mode === mode;
        tab.textContent = text(tab.dataset.mode === "files" ? "allFiles" : "modifiedTab");
        tab.setAttribute("aria-selected", String(isSelected)); tab.tabIndex = isSelected ? 0 : -1;
      }
      if (active) {
        $("changes-commit").classList.add("hidden"); $("changes-summary").classList.add("hidden");
        $("changes-repository").textContent = context().cwd || "";
        $("changes-title").textContent = mode === "files" ? text("projectFiles") : text("fileCount", { count: turn.length });
        $("changes-title").previousElementSibling.textContent = text(mode === "files" ? "readOnly" : "thisTurn");
      }
      $("changes-refresh").classList.toggle("hidden", mode === "modified" && !!turn);
      if (active) $("changes-refresh").disabled = !!directoryRequest || !!fileRequest;
      return active;
    }
    function changed() { onModeChange(); chrome(); }
    function turnView(focusPath) {
      body.replaceChildren(); body.className = "project-browser project-turn-files";
      const totals = turn.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
      const summary = node("div", "project-turn-summary", text("recordedChanges")); summary.append(numbers(totals)); body.append(summary);
      for (const [index, file] of turn.entries()) {
        const details = node("details", "project-turn-file"); details.dataset.path = file.path;
        const head = node("summary", "project-turn-file-head");
        const relative = view.relativeFile(context().cwd, file.path);
        const copy = node("span", "project-turn-file-copy"); const parts = (relative || file.path).replace(/\\/g, "/").split("/");
        copy.append(node("strong", "", parts.pop()), node("small", "", parts.join("/"))); copy.title = file.path;
        head.append(icon("chevron-right"), copy, numbers(file)); details.append(head);
        let populated = false;
        function populate() {
          if (!details.open || populated) return; populated = true;
          const content = node("div", "project-turn-diff");
          if (relative !== null) {
            const action = button("project-current-file", text("currentFile"), () => openFile(relative));
            action.textContent = "↗";
            content.append(action);
          }
          if (!file.sections?.length && !file.truncated) content.append(notice(text("missingDiff")));
          for (const section of file.sections || []) {
            if (section.kind !== "diff") content.append(node("div", "project-excerpt-label", text(section.kind === "content" ? "recordedContent" : "recordedEdit")));
            content.append(view.codeBlock(document, section.diff, file.path, { diff: section.kind !== "content" }));
          }
          if (file.truncated || file.sections?.some(section => view.lineCount(section.diff) > view.MAX_LINES)) content.append(notice(text("previewTruncated")));
          details.append(content);
        }
        details.addEventListener("toggle", populate); details.open = focusPath ? file.path === focusPath : index < 3;
        populate(); body.append(details);
        if (focusPath === file.path) requestAnimationFrame(() => details.scrollIntoView({ block: "start" }));
      }
    }
    function renderListing() {
      const list = body.querySelector(".project-directory-list"); if (!list) return;
      list.replaceChildren();
      if (directoryRequest) { list.append(notice(text("loading"))); return; }
      if (listingError) { list.append(notice(errorText(listingError))); return; }
      const entries = (listing?.entries || []).filter(entry => (hidden || !entry.hidden) && entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
      if (!entries.length) list.append(notice(text(filter ? "noMatches" : "emptyFolder")));
      for (const entry of entries) {
        const row = button("project-directory-row" + (entry.path === selected ? " selected" : ""), entry.name, () => {
          if (entry.kind === "directory") void loadDirectory(entry.path);
          else void loadFile(entry.path);
        });
        row.dataset.path = entry.path; row.dataset.kind = entry.kind;
        row.replaceChildren(icon(entry.kind === "directory" ? "folder" : entry.link ? "link" : "book"), node("span", "project-entry-name", entry.name));
        if (entry.kind === "directory") row.append(icon("chevron-right"));
        if (entry.blocked) { row.disabled = true; row.title = text(entry.kind === "unsupported" ? "notTextFile" : "outsideProject"); }
        row.setAttribute("aria-label", `${entry.name}${entry.kind === "directory" ? "/" : ""}`); list.append(row);
      }
      if (listing?.truncated) list.append(notice(text("listTruncated")));
    }
    function renderPreview() {
      const pane = body.querySelector(".project-file-preview"); if (!pane) return;
      pane.replaceChildren();
      const back = button("project-files-back", text("allFiles"), () => { layer.classList.remove("file-detail-open"); body.querySelector(".project-directory-row.selected")?.focus(); });
      back.prepend(icon("arrow-left")); pane.append(back);
      if (!selected) { pane.append(notice(text("selectFile"))); return; }
      const heading = node("div", "project-preview-heading");
      heading.append(node("strong", "", selected.split("/").pop()), node("small", "", selected)); pane.append(heading);
      if (fileRequest) { pane.append(notice(text("diffLoading"))); return; }
      if (previewError) { pane.append(notice(errorText(previewError))); return; }
      if (preview?.binary) { pane.append(notice(text("binary"))); return; }
      if (!preview) return;
      const content = node("div", "project-preview-code");
      if (preview.truncated || view.lineCount(preview.content) > view.MAX_LINES) content.append(notice(text("previewTruncated")));
      content.append(view.codeBlock(document, preview.content || "", selected)); pane.append(content);
    }
    function filesView() {
      body.replaceChildren(); body.className = "project-browser project-all-files";
      const sidebar = node("section", "project-directory");
      const crumbs = node("nav", "project-breadcrumbs"); crumbs.setAttribute("aria-label", text("projectFiles"));
      const paths = folder.split("/").filter(Boolean);
      const root = button("project-breadcrumb", (context().cwd || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || text("project"), () => void loadDirectory("")); crumbs.append(root);
      for (const [index, name] of paths.entries()) {
        crumbs.append(node("span", "project-breadcrumb-separator", "/"), button("project-breadcrumb", name, () => void loadDirectory(paths.slice(0, index + 1).join("/"))));
      }
      crumbs.lastElementChild?.setAttribute("aria-current", "location");
      const input = node("input", "project-file-filter"); input.type = "search"; input.placeholder = text("filterFolder"); input.setAttribute("aria-label", text("filterFolder")); input.value = filter;
      input.addEventListener("input", () => { filter = input.value; renderListing(); });
      const option = node("label", "project-hidden-option"); const check = node("input"); check.type = "checkbox"; check.checked = hidden;
      check.addEventListener("change", () => { hidden = check.checked; renderListing(); }); option.append(check, document.createTextNode(text("showHidden")));
      const list = node("div", "project-directory-list"); list.setAttribute("aria-label", text("allFiles"));
      sidebar.append(crumbs, input, option, list); body.append(sidebar, node("section", "project-file-preview")); renderListing(); renderPreview();
    }
    async function loadDirectory(path = "", { keepFile = false } = {}) {
      directoryRequest?.controller.abort();
      if (!keepFile) { fileRequest?.controller.abort(); fileRequest = null; selected = ""; preview = null; previewError = null; layer.classList.remove("file-detail-open"); }
      const request = { controller: new AbortController(), key: key() }; directoryRequest = request;
      folder = path; filter = ""; listing = null; listingError = null; filesView(); changed();
      try {
        const result = await api(`/api/project-files?cwd=${encodeURIComponent(context().cwd)}&path=${encodeURIComponent(path)}`, { signal: request.controller.signal });
        if (directoryRequest !== request || key() !== request.key) return; listing = result;
      } catch (error) { if (directoryRequest !== request || key() !== request.key || error.name === "AbortError") return; listingError = error; }
      finally { if (directoryRequest === request) { directoryRequest = null; renderListing(); changed(); } }
    }
    async function loadFile(path) {
      fileRequest?.controller.abort();
      const request = { controller: new AbortController(), key: key() }; fileRequest = request;
      selected = path; preview = null; previewError = null; layer.classList.add("file-detail-open"); renderListing(); renderPreview(); changed();
      try {
        const result = await api(`/api/project-file?cwd=${encodeURIComponent(context().cwd)}&path=${encodeURIComponent(path)}`, { signal: request.controller.signal });
        if (fileRequest !== request || key() !== request.key) return; preview = result;
      } catch (error) { if (fileRequest !== request || key() !== request.key || error.name === "AbortError") return; previewError = error; }
      finally { if (fileRequest === request) { fileRequest = null; renderPreview(); changed(); } }
    }
    function openFile(path) {
      mode = "files"; layer.classList.remove("show-detail");
      void loadDirectory(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "", { keepFile: true });
      void loadFile(path);
    }
    function selectMode(next) {
      if (next === mode) return;
      abort(); mode = next; layer.classList.remove("show-detail", "file-detail-open");
      if (mode === "files") void loadDirectory(folder);
      else if (turn) turnView();
      changed();
    }
    for (const tab of tabs.querySelectorAll("button")) tab.addEventListener("click", () => selectMode(tab.dataset.mode));
    tabs.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const next = event.key === "Home" ? "modified" : event.key === "End" ? "files" : mode === "files" ? "modified" : "files";
      selectMode(next); tabs.querySelector(`[data-mode="${next}"]`).focus();
    });
    return {
      get active() { return mode === "files" || !!turn; },
      sync: chrome,
      openTurn(files, path) { abort(); turn = files; mode = "modified"; layer.classList.remove("show-detail", "file-detail-open"); turnView(path); changed(); },
      reset() { abort(); turn = null; mode = "modified"; folder = ""; selected = ""; listing = null; preview = null; layer.classList.remove("file-detail-open"); body.replaceChildren(); chrome(); },
      close: abort,
      refresh() { if (mode !== "files") return; const file = selected; void loadDirectory(folder, { keepFile: !!file }); if (file) void loadFile(file); },
    };
  }
  window.stepsembleProjectBrowser = Object.freeze({ create });
})();
