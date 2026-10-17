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
      else { link.target = "_blank"; link.rel = "noopener noreferrer"; }
      return link;
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
    function fileActions(file, open) {
      const actions = node("span", "assistant-file-actions");
      if (open) actions.append(action("assistant-file-open", file, "open", false));
      actions.append(action("assistant-file-save", file, "download", true), shareAction(file));
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
      if (!unavailable) box.append(fileActions(file, open));
      return box;
    }
    function card(file) {
      if (file.kind === "image") {
        const figure = node("figure", "assistant-file-photo"), link = node("a", "assistant-file-image");
        figure.dataset.kind = file.kind;
        link.href = mediaUrl(file.path); link.target = "_blank"; link.rel = "noopener noreferrer";
        link.setAttribute("aria-label", `${t("fileOpen")} ${file.name}`);
        const image = node("img");
        image.alt = file.name; image.loading = "lazy"; image.decoding = "async";
        image.addEventListener("error", () => figure.replaceWith(fileCard(file, { unavailable: true })), { once: true });
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
    return Object.freeze({ markdown, plain });
  }
  root.StepsembleAssistantContent = Object.freeze({ create });
})(window);
