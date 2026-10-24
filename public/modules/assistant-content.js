(function (root) {
  "use strict";

  // 每個寬內容都有自己的捲動範圍，不讓表格或圖片撐開整個對話。
  // Bot 用 MEDIA:/路徑 傳來的檔案在回覆完成後變成附件卡片；串流中只隱藏標記。
  function create({ document: doc = document, marked = root.marked, purify = root.DOMPurify, media = root.StepsembleAssistantMedia,
    t = key => key, mediaUrl = null, icon, toast } = {}) {
    const view = doc.defaultView || root;
    function render(text) {
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

    function node(tag, className, text) {
      const item = doc.createElement(tag);
      if (className) item.className = className;
      if (text !== undefined) item.textContent = text;
      return item;
    }
    function action(className, file, name, download) {
      const link = node("a", className), label = `${t(download ? "fileDownload" : "fileOpen")} ${file.name}`;
      link.href = mediaUrl(file.path, download);
      link.setAttribute("aria-label", label); link.title = label;
      link.append(icon(name));
      if (download) link.setAttribute("download", file.name);
      else {
        link.target = "_blank"; link.rel = "noopener noreferrer";
        link.addEventListener("click", event => { if (plainClick(event) && (VIEWED.has(file.kind) || homeScreen())) { event.preventDefault(); openViewer(file, link); } });
      }
      return link;
    }

    // Pictures, videos and sound open in a viewer over the page, and so do PDFs
    // and text in an app added to the home screen: a link away from the page
    // would leave that app stuck on the file, as iOS shows it there without a
    // browser bar or a way back. Close, Escape, a tap beside the picture or a
    // swipe down return to the conversation.
    const VIEWED = new Set(["image", "video", "audio"]);
    let viewer = null;
    const plainClick = event => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    function homeScreen() {
      const app = win => win.navigator.standalone === true || ["standalone", "fullscreen", "minimal-ui"].some(mode => win.matchMedia?.(`(display-mode: ${mode})`).matches);
      try { return app(view) || (view.top !== view && app(view.top)); } catch { return false; }
    }
    // iOS opens a download inside an app on its home screen too, with no way
    // back; there the share sheet saves the file (Save Image, Save to Files).
    function iosHomeScreen() {
      try { return view.navigator.standalone === true || (view.top !== view && view.top.navigator.standalone === true); } catch { return false; }
    }
    function closeViewer() {
      const open = viewer; if (!open) return;
      viewer = null;
      for (const player of open.layer.querySelectorAll("video, audio")) player.pause();
      open.layer.remove();
      doc.removeEventListener("keydown", open.keys, true);
      for (const [item, inert] of open.covered) item.inert = inert;
      doc.body.classList.remove("assistant-viewer-open");
      if (open.trigger?.isConnected) open.trigger.focus({ preventScroll: true });
    }
    // file: a Bot's file ({ path, name, kind }) or a picture this page holds ({ src, name, kind }).
    function openViewer(file, trigger = doc.activeElement) {
      closeViewer();
      const layer = node("div", `assistant-viewer ${file.kind}`), bar = node("div", "assistant-viewer-bar"), stage = node("div", "assistant-viewer-stage");
      layer.setAttribute("role", "dialog"); layer.setAttribute("aria-modal", "true"); layer.setAttribute("aria-label", file.name);
      const close = node("button", "assistant-viewer-close"); close.type = "button";
      close.setAttribute("aria-label", t("viewerClose")); close.title = t("viewerClose"); close.append(icon("close"));
      close.addEventListener("click", closeViewer);
      bar.append(close, node("span", "assistant-viewer-name", file.name));
      if (file.kind === "video") {
        // An iPhone has no full screen for page elements; its own player is
        // full screen, turns with the phone and closes back to the viewer.
        const full = node("button", "assistant-viewer-full"); full.type = "button";
        full.setAttribute("aria-label", t("fullScreen")); full.title = t("fullScreen"); full.append(icon("expand"));
        full.addEventListener("click", () => {
          const player = stage.querySelector("video");
          try {
            if (doc.fullscreenEnabled && player.requestFullscreen) player.requestFullscreen().catch(() => {});
            else player.webkitEnterFullscreen?.();
          } catch {}
        });
        bar.append(full);
      }
      if (file.path) {
        const actions = node("span", "assistant-file-actions assistant-viewer-actions");
        // A browser has tabs to come back from; an app on the home screen has none.
        if (!homeScreen()) {
          const tab = node("a", "assistant-file-open"), label = `${t("fileOpenTab")} ${file.name}`;
          tab.href = mediaUrl(file.path); tab.target = "_blank"; tab.rel = "noopener noreferrer";
          tab.setAttribute("aria-label", label); tab.title = label; tab.append(icon("open"));
          actions.append(tab);
        }
        if (!iosHomeScreen()) actions.append(action("assistant-file-save", file, "download", true));
        actions.append(shareAction(file));
        bar.append(actions);
      }
      const src = file.src || mediaUrl(file.path);
      // Text is read and shown as it is; a PDF shows in the browser's own viewer.
      const content = file.kind === "image" ? node("img") : VIEWED.has(file.kind) ? node(file.kind) : file.kind === "text" ? node("pre") : node("iframe");
      content.className = "assistant-viewer-media";
      if (file.kind === "image") content.alt = file.name;
      else if (VIEWED.has(file.kind)) { content.controls = true; content.autoplay = true; content.playsInline = true; }
      else if (file.kind === "text") {
        content.tabIndex = 0;
        view.fetch(mediaUrl(file.path, true), { credentials: "same-origin" })
          .then(response => { if (!response.ok) throw new Error(String(response.status)); return response.text(); })
          .then(text => { content.textContent = text; }, () => { content.textContent = t("fileUnavailable"); });
      } else content.title = file.name;
      if (file.kind !== "text") content.src = src;
      stage.append(content); layer.append(bar, stage);
      stage.addEventListener("click", event => { if (event.target === stage) closeViewer(); });
      let start = null;
      stage.addEventListener("touchstart", event => {
        const touch = event.touches[0], zoomed = (view.visualViewport?.scale || 1) > 1.01;
        start = event.touches.length === 1 && !zoomed ? { x: touch.clientX, y: touch.clientY } : null;
      }, { passive: true });
      stage.addEventListener("touchend", event => {
        const touch = event.changedTouches[0], from = start; start = null;
        if (from && touch && touch.clientY - from.y > 90 && Math.abs(touch.clientX - from.x) < (touch.clientY - from.y) / 2) closeViewer();
      }, { passive: true });
      const covered = new Map();
      for (const item of doc.body.children) { covered.set(item, item.inert); item.inert = true; }
      const keys = event => {
        if (viewer?.layer !== layer) return;
        // Escape in full screen leaves full screen only.
        if (event.key === "Escape" && !doc.fullscreenElement) { event.preventDefault(); event.stopPropagation(); closeViewer(); }
        if (event.key === "Tab") {
          const focusable = [...layer.querySelectorAll("button:not([disabled]), a[href], video, audio, iframe, pre")].filter(item => item.getClientRects().length);
          const first = focusable[0], last = focusable.at(-1);
          if (!layer.contains(doc.activeElement)) { event.preventDefault(); first?.focus(); }
          else if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      };
      doc.addEventListener("keydown", keys, true);
      doc.body.append(layer); doc.body.classList.add("assistant-viewer-open");
      viewer = { layer, covered, keys, trigger };
      close.focus({ preventScroll: true });
      // Started from the tap that opened it, so a phone lets it play with sound.
      if (file.kind === "video" || file.kind === "audio") content.play?.()?.catch?.(() => {});
    }
    function shareAction(file) {
      const button = node("button", "assistant-file-share"), nav = view.navigator;
      const label = `${t("fileShare")} ${file.name}`;
      const supported = view.isSecureContext && typeof nav.share === "function" && typeof nav.canShare === "function";
      button.type = "button"; button.setAttribute("aria-label", label); button.append(icon("share"));
      button.disabled = !supported;
      button.title = supported ? label : t("fileShareUnavailable");
      if (!supported) button.setAttribute("aria-description", t("fileShareUnavailable"));
      let prepared = null;
      button.addEventListener("click", async () => {
        if (button.disabled) return;
        const wasPrepared = !!prepared, restoreFocus = doc.activeElement === button;
        let retryWithGesture = false;
        button.disabled = true; button.setAttribute("aria-busy", "true");
        try {
          if (!prepared) {
            const response = await view.fetch(mediaUrl(file.path, true), { credentials: "same-origin" });
            if (!response.ok) { toast(t("fileUnavailable")); return; }
            const blob = await response.blob();
            prepared = new view.File([blob], file.name, { type: blob.type.split(";")[0] || "application/octet-stream" });
          }
          if (!button.isConnected) return;
          const data = { files: [prepared] };
          if (!nav.canShare(data)) { toast(t("fileShareUnavailable")); return; }
          await nav.share(data);
        } catch (error) {
          // 有些瀏覽器不保留讀檔期間的手勢；保留原檔，下一次點擊同步開啟分享面板。
          if (error.name === "NotAllowedError" && prepared && !wasPrepared) {
            retryWithGesture = true; toast(t("fileShareReady"));
          } else if (error.name !== "AbortError") toast(t("fileShareFailed"));
        } finally {
          if (!retryWithGesture) prepared = null;
          button.disabled = false; button.removeAttribute("aria-busy");
          if (restoreFocus && button.isConnected && doc.activeElement === doc.body) button.focus({ preventScroll: true });
        }
      });
      return button;
    }
    // Dragged out of the page a Bot's file lands as the file itself: Chrome and
    // Edge download it where it is dropped (DownloadURL), and the Mac app turns
    // the address of a file it is handed into the file (WorkspaceWebView in
    // macos/Stepsemble/main.swift). A link (the picture) already carries its
    // address; WebKit writes a link's own data only when the page writes none.
    const chromium = /Chrom(?:e|ium)\//.test(view.navigator.userAgent || "");
    function dragOut(element, file, { link = false } = {}) {
      element.draggable = true;
      element.addEventListener("dragstart", event => {
        const data = event.dataTransfer;
        if (!data || event.target.closest?.("button, a") && event.target.closest("button, a") !== element) return;
        const url = new URL(mediaUrl(file.path, true), view.location.href).href, type = media?.contentType?.(file.path) || "application/octet-stream";
        data.effectAllowed = "copy";
        if (chromium) data.setData("DownloadURL", `${type}:${file.name.replace(/:/g, "_")}:${url}`);
        if (!link) { data.setData("text/uri-list", url); data.setData("text/plain", url); }
      });
    }
    function fileActions(file, open) {
      const actions = node("span", "assistant-file-actions");
      if (open) actions.append(action("assistant-file-open", file, "open", false));
      if (!iosHomeScreen()) actions.append(action("assistant-file-save", file, "download", true));
      actions.append(shareAction(file));
      return actions;
    }
    function fileCard(file, { unavailable = false, open = ["pdf", "text", "video", "audio"].includes(file.kind) } = {}) {
      const box = node("div", `assistant-file${unavailable ? " unavailable" : ""}`);
      box.dataset.kind = file.kind;
      const badge = node("span", "assistant-file-badge", (file.ext || "file").slice(0, 4).toUpperCase());
      badge.setAttribute("aria-hidden", "true");
      const copy = node("span", "assistant-file-copy"), name = node("span", "assistant-file-name", file.name);
      name.title = file.path;
      copy.append(name);
      if (unavailable) copy.append(node("small", "", t("fileUnavailable")));
      box.append(badge, copy);
      if (!unavailable) { box.append(fileActions(file, open)); dragOut(box, file); }
      return box;
    }
    function card(file) {
      if (file.kind === "image") {
        const figure = node("figure", "assistant-file-photo"), link = node("a", "assistant-file-image");
        figure.dataset.kind = file.kind;
        link.href = mediaUrl(file.path); link.target = "_blank"; link.rel = "noopener noreferrer";
        link.setAttribute("aria-label", `${t("fileOpen")} ${file.name}`);
        link.addEventListener("click", event => { if (plainClick(event)) { event.preventDefault(); openViewer(file, link); } });
        dragOut(link, file, { link: true });
        const image = node("img");
        image.alt = file.name; image.loading = "lazy"; image.decoding = "async";
        image.addEventListener("error", () => figure.replaceWith(fileCard(file, { unavailable: true })), { once: true });
        image.addEventListener("load", () => link.classList.add("loaded"), { once: true });
        image.src = mediaUrl(file.path);
        link.append(image); figure.append(fileActions(file, true), link);
        return figure;
      }
      if (file.kind === "video" || file.kind === "audio") {
        const figure = node("figure", `assistant-file-media ${file.kind}`), player = node(file.kind);
        player.controls = true; player.preload = file.kind === "video" ? "metadata" : "none";
        if (file.kind === "video") player.playsInline = true;
        player.addEventListener("error", () => figure.replaceWith(fileCard(file, { unavailable: true })), { once: true });
        player.src = mediaUrl(file.path);
        figure.append(player, fileCard(file));
        return figure;
      }
      return fileCard(file);
    }

    function markdown(text, { complete = true } = {}) {
      const found = media ? media.extract(text, { partial: !complete }) : { text: String(text || ""), files: [] };
      const box = render(found.text);
      if (complete && found.files.length && mediaUrl) {
        const list = node("div", "assistant-files");
        list.append(...found.files.map(card));
        box.append(list);
      }
      return box;
    }
    // 列表預覽只顯示文字；只有附件時改顯示檔名，不露出電腦上的路徑。
    function plain(text) {
      if (!media) return String(text || "");
      const found = media.extract(text, { partial: true });
      return found.text || found.files.map(file => file.name).join(", ");
    }
    return Object.freeze({ markdown, plain, view: openViewer, closeViewer });
  }
  root.StepsembleAssistantContent = Object.freeze({ create });
})(window);
