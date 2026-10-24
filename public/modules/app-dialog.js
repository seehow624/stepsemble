/* Questions the app asks before it acts, drawn in the app's own look rather
   than as the browser's confirm()/prompt(). A browser dialog has the page's
   address as its title, an "OK" that names no action and no way to mark a
   destructive one; on iOS it also leaves the app's colours. One question is
   shown at a time; a second waits for the first. Escape or Cancel answers
   no. The answer is a promise, so a caller must recheck what it acts on. */
(function(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StepsembleAppDialog = api;
})(typeof window !== "undefined" ? window : globalThis, function(root) {
  "use strict";
  const locales = ["en", "zh-Hans", "zh-Hant", "ja", "ko", "tr", "fr", "de", "es", "pt-BR", "it"];
  // Button labels name the action, as Apple's guidelines ask: "Delete", not "OK".
  const copy = {
    ok: ["OK", "确定", "確定", "OK", "확인", "Tamam", "OK", "OK", "Aceptar", "OK", "OK"],
    cancel: ["Cancel", "取消", "取消", "キャンセル", "취소", "Vazgeç", "Annuler", "Abbrechen", "Cancelar", "Cancelar", "Annulla"],
    delete: ["Delete", "删除", "刪除", "削除", "삭제", "Sil", "Supprimer", "Löschen", "Eliminar", "Excluir", "Elimina"],
    remove: ["Remove", "移除", "移除", "削除", "제거", "Kaldır", "Retirer", "Entfernen", "Quitar", "Remover", "Rimuovi"],
    revoke: ["Revoke", "撤销", "撤銷", "取り消す", "철회", "İptal et", "Révoquer", "Widerrufen", "Revocar", "Revogar", "Revoca"],
    reset: ["Reset", "重置", "重設", "リセット", "재설정", "Sıfırla", "Réinitialiser", "Zurücksetzen", "Restablecer", "Redefinir", "Ripristina"],
    restart: ["Restart", "重新启动", "重新啟動", "再起動", "다시 시작", "Yeniden başlat", "Redémarrer", "Neu starten", "Reiniciar", "Reiniciar", "Riavvia"],
    stop: ["Stop", "停止", "停止", "停止", "중지", "Durdur", "Arrêter", "Stoppen", "Detener", "Parar", "Interrompi"],
    install: ["Install", "安装", "安裝", "インストール", "설치", "Yükle", "Installer", "Installieren", "Instalar", "Instalar", "Installa"],
    upgrade: ["Upgrade", "升级", "升級", "アップグレード", "업그레이드", "Yükselt", "Mettre à niveau", "Aktualisieren", "Actualizar", "Atualizar", "Aggiorna"],
    import: ["Import", "导入", "匯入", "読み込む", "가져오기", "İçe aktar", "Importer", "Importieren", "Importar", "Importar", "Importa"],
    commit: ["Commit", "提交", "提交", "コミット", "커밋", "Commit", "Valider", "Committen", "Hacer commit", "Fazer commit", "Esegui commit"],
    commitMessage: ["Commit message", "提交说明", "提交說明", "コミットメッセージ", "커밋 메시지", "Commit mesajı", "Message de commit", "Commit-Nachricht", "Mensaje del commit", "Mensagem do commit", "Messaggio di commit"],
    create: ["Create", "创建", "建立", "作成", "만들기", "Oluştur", "Créer", "Erstellen", "Crear", "Criar", "Crea"],
    enable: ["Turn on", "开启", "開啟", "オンにする", "켜기", "Aç", "Activer", "Einschalten", "Activar", "Ativar", "Attiva"],
    includeKeys: ["Include API keys", "包含 API key", "包含 API key", "API キーを含める", "API 키 포함", "API anahtarlarını ekle", "Inclure les clés API", "API-Schlüssel einschließen", "Incluir claves API", "Incluir chaves de API", "Includi chiavi API"],
    withoutKeys: ["Export without keys", "不含密钥导出", "不含金鑰匯出", "キーなしで書き出す", "키 없이 내보내기", "Anahtarsız dışa aktar", "Exporter sans les clés", "Ohne Schlüssel exportieren", "Exportar sin claves", "Exportar sem chaves", "Esporta senza chiavi"],
  };
  function language() {
    const asked = root.stepsembleI18n?.getLocale?.() || root.document?.documentElement?.lang || "en";
    if (locales.includes(asked)) return asked;
    if (/^zh[-_](hant|tw|hk|mo)/i.test(asked)) return "zh-Hant";
    if (/^zh/i.test(asked)) return "zh-Hans";
    if (/^pt/i.test(asked)) return "pt-BR";
    const base = String(asked).split(/[-_]/)[0];
    return locales.includes(base) ? base : "en";
  }
  function label(name) {
    const row = copy[name];
    return row ? row[locales.indexOf(language())] || row[0] : String(name || "");
  }
  // "Question? Why it matters." reads as a bold question over a quieter
  // explanation; a first line break makes the same split.
  function split(text) {
    const value = String(text ?? "").trim();
    const line = value.indexOf("\n");
    if (line > 0) return { title: value.slice(0, line).trim(), body: value.slice(line + 1).trim() };
    const match = /^(.+?[?？])(\s+|(?=[^\s]))(.+)$/su.exec(value);
    return match ? { title: match[1].trim(), body: match[3].trim() } : { title: value, body: "" };
  }

  let queue = Promise.resolve(), sequence = 0;
  // ask({ title, body, details, note, field, actions, initial, still })
  // resolves to the chosen action's id, or null for Cancel or Escape. A
  // field's value comes back as { id, value }. still(), if given, runs when
  // the question's turn comes: a question that waited behind another and
  // whose yes could no longer act is not shown, and answers null.
  // A question's turn comes a task after the one before it was answered, so
  // that question's caller has acted on its answer before still() looks.
  const nextTask = () => new Promise(resolve => (root.setTimeout || setTimeout)(resolve, 0));
  function ask(options) {
    const turn = queue.then(nextTask).then(() => show(options));
    queue = turn.catch(() => {});
    return turn;
  }
  function show({ title, body = "", details = [], note = "", field = null, actions = [], cancel = "cancel", initial = "cancel", still = null }) {
    if (typeof still === "function" && !still()) return Promise.resolve(null);
    const doc = root.document;
    if (!doc?.body || typeof doc.createElement("dialog").showModal !== "function") return Promise.resolve(null);
    return new Promise(resolve => {
      const id = "app-dialog-" + (++sequence), returnFocus = doc.activeElement;
      const dialog = doc.createElement("dialog");
      dialog.className = "app-dialog";
      dialog.setAttribute("role", "alertdialog");
      dialog.setAttribute("aria-labelledby", id + "-title");
      // Callers pass words already in the reader's language; the page's own
      // translator would otherwise swap a question for its longer entry.
      dialog.setAttribute("data-i18n-ignore", "");
      const heading = doc.createElement("h2");
      heading.id = id + "-title"; heading.className = "app-dialog-title"; heading.textContent = title;
      dialog.append(heading);
      const described = [];
      if (body) {
        const text = doc.createElement("p");
        text.id = id + "-body"; text.className = "app-dialog-body"; text.textContent = body;
        dialog.append(text); described.push(text.id);
      }
      const rows = (details || []).map(String).filter(Boolean);
      if (rows.length) {
        const list = doc.createElement("ul");
        list.id = id + "-details"; list.className = "app-dialog-details";
        for (const row of rows) { const item = doc.createElement("li"); item.textContent = row; list.append(item); }
        dialog.append(list); described.push(list.id);
      }
      if (note) {
        const text = doc.createElement("p");
        text.id = id + "-note"; text.className = "app-dialog-body app-dialog-note"; text.textContent = note;
        dialog.append(text); described.push(text.id);
      }
      if (described.length) dialog.setAttribute("aria-describedby", described.join(" "));
      let input = null;
      if (field) {
        const wrap = doc.createElement("label");
        wrap.className = "app-dialog-field";
        const name = doc.createElement("span");
        name.className = "app-dialog-field-label"; name.textContent = field.label ? label(field.label) : "";
        input = doc.createElement("input");
        input.type = "text"; input.value = field.value || ""; input.placeholder = field.placeholder || "";
        input.autocomplete = "off"; input.spellcheck = field.spellcheck !== false;
        wrap.append(name, input);
        dialog.append(wrap);
      }
      const bar = doc.createElement("div");
      bar.className = "app-dialog-actions";
      const buttons = new Map();
      const add = (key, text, tone) => {
        const button = doc.createElement("button");
        button.type = "button"; button.className = "btn " + tone; button.textContent = text; button.dataset.action = key;
        button.addEventListener("click", () => finish(key === "cancel" ? null : key));
        bar.append(button); buttons.set(key, button);
        return button;
      };
      if (cancel) add("cancel", label(cancel), "ghost");
      for (const action of actions) add(action.id, label(action.label || action.id), action.tone === "destructive" ? "danger" : action.tone === "secondary" ? "ghost" : "primary");
      dialog.append(bar);
      const primary = actions.length ? buttons.get(actions[actions.length - 1].id) : null;
      // A required field keeps its action unavailable until it holds text.
      const sync = () => { if (input && field.required && primary) primary.disabled = !input.value.trim(); };
      input?.addEventListener("input", sync);
      // Enter answers only when no input method used it to confirm text
      // (modules/composer-ime.js); without that check it does nothing.
      input?.addEventListener("keydown", event => {
        if (!root.stepsembleComposerIme?.isEnter(event)) return;
        event.preventDefault();
        if (primary && !primary.disabled) primary.click();
      });
      sync();
      let done = false;
      function finish(choice) {
        if (done) return;
        done = true;
        const value = input ? input.value : undefined;
        dialog.close();
        dialog.remove();
        if (returnFocus?.isConnected && typeof returnFocus.focus === "function") returnFocus.focus({ preventScroll: true });
        resolve(choice === null ? null : input ? { id: choice, value } : choice);
      }
      // Escape answers Cancel and goes no further: the page's own Escape would
      // also close the sheet the question was asked from. Other keys stay in
      // the dialog too, away from the page's shortcuts.
      dialog.addEventListener("keydown", event => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); finish(null); }
      });
      dialog.addEventListener("cancel", event => { event.preventDefault(); finish(null); });
      dialog.addEventListener("close", () => finish(null));
      doc.body.append(dialog);
      dialog.showModal();
      (initial === "field" && input ? input : initial === "action" && primary ? primary : buttons.get("cancel") || primary)?.focus();
    });
  }

  // confirm(question, { action, destructive, details, note }) resolves true
  // or false. A destructive question starts on Cancel.
  async function confirm(question, { action = "ok", destructive = false, details = [], note = "", still = null } = {}) {
    const { title, body } = split(question);
    const choice = await ask({ title, body, details, note, still, actions: [{ id: "confirm", label: action, tone: destructive ? "destructive" : "primary" }], initial: destructive ? "cancel" : "action" });
    return choice === "confirm";
  }
  // prompt(question, { action, label, value, required }) resolves the text, or null.
  async function prompt(question, { action = "ok", label: fieldLabel = "", value = "", placeholder = "", required = true, spellcheck = true } = {}) {
    const { title, body } = split(question);
    const choice = await ask({ title, body, field: { label: fieldLabel, value, placeholder, required, spellcheck }, actions: [{ id: "confirm", label: action }], initial: "field" });
    return choice ? choice.value : null;
  }
  // choose(question, actions) resolves the chosen action's id, or null.
  async function choose(question, actions, { details = [], note = "" } = {}) {
    const { title, body } = split(question);
    return ask({ title, body, details, note, actions, initial: "cancel" });
  }

  return { ask, confirm, prompt, choose, split, label, locales, copy };
});
