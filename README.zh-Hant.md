# Pi Harbor（繁體中文）

[English](README.md) · [简体中文](README.zh-Hans.md) · 繁體中文 · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Pi Harbor 是開源、手機優先的 Pi coding agent 網頁客戶端。它支援瀏覽與繼續工作階段、建立專案、預覽圖片，也能從手機或桌面瀏覽器切換多台 Pi Harbor 電腦。

## 隱私與安全

倉庫只包含應用程式碼與通用部署範本，不包含 token、工作階段記錄、專案檔案、私有網址、帳號憑證、模型使用歷史、用量統計或任何特定電腦設定。token 應保存在本機權限為 `600` 的檔案，服務預設只監聽回環位址，再透過 Tailscale Serve 或其他 HTTPS 閘道存取。

## 快速開始

在每一台要執行 Pi Harbor 的電腦上執行：

```bash
git clone https://github.com/seehow624/pi-harbor.git
cd pi-harbor
mkdir -p ~/.config/pi-web
openssl rand -hex 32 > ~/.config/pi-web/token
chmod 600 ~/.config/pi-web/token
PI_WEB_TOKEN_FILE="$HOME/.config/pi-web/token" node server.js
```

開啟 HTTPS 位址並輸入本機 token。不要把 token 寫入 Git、問題單、聊天、截圖或日誌。

## 多台電腦

每台電腦都執行自己的 Pi Harbor 實例。在 **Settings → Devices** 加入顯示名稱與可存取的 HTTPS 位址，也可以使用一次性配對碼。顯示名稱只影響介面，不會修改系統主機名稱。

## 自動更新

`deploy/` 內的 launchd 範本可定時從公開 GitHub 分支或標籤下載更新，安全替換應用程式後重新啟動服務。更新器不會修改 Pi 工作階段、專案檔案、Provider 憑證或 Web token。

## 開發與測試

```bash
npm run check
npm test
```

完整部署、設定與安全說明請參閱[英文文件](README.md)。
