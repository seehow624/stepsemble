# Pi Web（日本語）

[English](README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · 日本語 · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Pi Web は、Pi coding agent 用のオープンソースなモバイル優先 Web クライアントです。セッションの閲覧と継続、プロジェクト作成、画像プレビュー、複数の Pi Web コンピューターの切り替えに対応します。

## プライバシーと安全性

このリポジトリにはアプリケーションコードと汎用のデプロイテンプレートだけが含まれます。トークン、セッションログ、プロジェクト、非公開 URL、認証情報、モデル利用履歴、使用量、特定のコンピューター設定は含まれません。トークンは権限 `600` のローカルファイルに保存し、HTTPS ゲートウェイ経由でアクセスしてください。

## クイックスタート

```bash
git clone https://github.com/seehow624/pi-web.git
cd pi-web
mkdir -p ~/.config/pi-web
openssl rand -hex 32 > ~/.config/pi-web/token
chmod 600 ~/.config/pi-web/token
PI_WEB_TOKEN_FILE="$HOME/.config/pi-web/token" node server.js
```

各コンピューターで Pi Web を実行し、HTTPS URL とローカルトークンでログインします。トークンを Git、チャット、スクリーンショット、ログに保存しないでください。

## 複数コンピューターと更新

**Settings → Devices** で表示名と HTTPS URL を追加できます。`deploy/` の launchd テンプレートで、公開 GitHub のブランチまたはタグから自動更新を設定できます。更新器はセッション、プロジェクト、認証情報を変更しません。

```bash
npm run check
npm test
```

詳細は[英語ドキュメント](README.md)を参照してください。
