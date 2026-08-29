# Pi Harbor（繁體中文）

[English](README.md) · [简体中文](README.zh-Hans.md) · 繁體中文 · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Pi Harbor 是開源、手機優先的 Pi coding agent 網頁客戶端。它支援瀏覽與繼續工作階段、建立專案、預覽圖片，也能從手機或桌面瀏覽器切換多台 Pi Harbor 電腦。

## 隱私與安全

倉庫只包含應用程式碼與通用部署範本，不包含 token、工作階段記錄、專案檔案、私有網址、帳號憑證、模型使用歷史、用量統計或任何特定電腦設定。token 應保存在本機權限為 `600` 的檔案，服務預設只監聽回環位址，再透過 Tailscale Serve 或其他 HTTPS 閘道存取。

## 快速開始

在每一台要執行 Pi Harbor 的電腦上執行：

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/pi-harbor/master/install.sh)"
```

安裝程式會檢查 Pi Agent 與 Node.js、下載並驗證最新穩定 Release、建立
launchd 服務與自動更新。若沒有 Pi Agent，會先詢問是否透過 Pi 官方安裝程式加入。

安裝完成後，請在執行 Pi Harbor 的電腦開啟終端機並執行：

```bash
cat ~/.config/pi-harbor/token
```

將 token 貼到登入頁；從其他裝置使用時，也請從該主機安全地取得 token。若服務明確設定了 `PI_HARBOR_TOKEN_FILE`，請讀取所設定的檔案，而不是預設路徑。絕不要把 token 寫入 Git、問題單、聊天、截圖或日誌。

在主機本機的瀏覽器首次開啟 Pi Harbor 時，會提供類似冷錢包的一次性密綰揭示導覽：密綰只會在 loopback 連線上顯示——絕不會透過 Tailscale Serve、代理或其他裝置——並在你完成兩項確認後永遠不再出現。其他裝置一律使用已保存的密綰或 token 檔案。

## 多台電腦

每台電腦都執行自己的 Pi Harbor 實例。在每台額外電腦上安裝並啟動 Pi Harbor，使用 Tailscale 或 HTTPS，然後在 **Settings → Devices → Add device** 加入網址，也可以使用五分鐘有效的一次性配對碼。兩台電腦使用相同的 Web token；憑證會保留在選定的主機上。不要將公開的 3140 port 暴露給不受信任的網路。

加入 LLM 服務商：開啟 **Settings → Connection → Models & providers**，選擇目錄服務、帳號／OAuth 登入、API key、本機服務或自訂 Provider，然後選擇要顯示的模型。

## 自動更新

預設每小時檢查 GitHub 的最新穩定 Release，並驗證 SHA-256。若 Pi 正在工作，更新會延後，完成後才替換應用程式。更新器不會修改 Pi 工作階段、專案檔案、Provider 憑證或 Web token。

## 移除

```bash
~/.local/share/pi-harbor-bin/uninstall.sh
```

可以選擇只移除 Pi Harbor，或連同 Pi Agent 執行檔一起移除；工作階段、憑證與專案資料夾都會保留。

## 開發與測試

```bash
npm run check
npm test
```

完整部署、設定與安全說明請參閱[英文文件](README.md)。
