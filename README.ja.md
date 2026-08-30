# Pi Harbor（日本語）

[English](README.md) · [中国語（簡体字）](README.zh-Hans.md) · [中国語（繁体字）](README.zh-Hant.md) · 日本語 · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Pi Harbor は、Pi coding agent 用のオープンソースなモバイル優先 Web クライアントです。セッションの閲覧と継続、プロジェクト作成、画像プレビュー、複数の Pi Harbor コンピューターの切り替えに対応します。

## プライバシーと安全性

このリポジトリにはアプリケーションコードと汎用のデプロイテンプレートだけが含まれます。トークン、セッションログ、プロジェクト、非公開 URL、認証情報、モデル利用履歴、使用量、特定のコンピューター設定は含まれません。トークンは権限 `600` のローカルファイルに保存し、HTTPS ゲートウェイ経由でアクセスしてください。

## クイックスタート

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/pi-harbor/master/install.sh)"
```

Pi Harbor を実行するコンピューターでターミナルを開き、次を実行してトークンを確認します。

```bash
cat ~/.config/pi-harbor/token
```

ログイン画面に貼り付けてください。別のデバイスからは、そのホストから安全に取得します。`PI_HARBOR_TOKEN_FILE` を明示的に設定している場合は、既定のパスではなく設定したファイルを読み取ります。トークンを Git、チャット、スクリーンショット、ログで共有しないでください。

ホストコンピューター上のブラウザーで Pi Harbor を初めて開くと、ハードウェアウォレット形式の一度きりのキー表示がログイン前に提供されます。キーは loopback 接続でのみ表示され（Tailscale Serve・プロキシ・リモートデバイス経由では決して表示されず）、2 つの確認を保存した後は二度と表示されません。他のデバイスでは、記録したキーまたはトークンファイルを使用します。

## 複数コンピューターと更新

各コンピューターに Pi Harbor をインストールして起動し、**Settings → Devices → Add device** で Tailscale または HTTPS URL を追加できます。URL の手動入力は従来の共有 Web トークン方式で、両方のホストに同じトークンが必要です。5 分間有効で一度だけ使える `PIHARBOR3` ペアリングコードなら、候補を確認した後に独立して取り消せるピア認証情報を作成し、共有トークンを候補 URL に送りません。Device 設定で承認済みデバイスを確認・取り消せます。Pi Harbor 2.2 は 2.1.2 ホストの `PIHARBOR2` コードを受け入れますが、旧クライアントは `PIHARBOR3` の前に更新が必要です。ポート 3140 を公開しないでください。**Settings → Connection → Models & providers** では、カタログサービス、アカウント／OAuth、API キー、ローカルサービス、カスタムプロバイダーを選び、表示するモデルを選択できます。`deploy/` の launchd テンプレートで、公開 GitHub のブランチまたはタグから自動更新を設定できます。更新器はセッション、プロジェクト、認証情報を変更しません。

```bash
npm run check
npm test
```

詳細は[英語ドキュメント](README.md)を参照してください。
