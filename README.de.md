# Pi Web (Deutsch)

[English](README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Français](README.fr.md) · Deutsch · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Pi Web ist ein quelloffener, mobil optimierter Webclient für Pi coding agent. Sitzungen können angezeigt und fortgesetzt, Projekte gestartet, Bilder angesehen und mehrere Pi-Web-Computer gewechselt werden.

## Datenschutz

Das Repository enthält nur Anwendungscode und allgemeine Bereitstellungsvorlagen. Es enthält keine Token, Sitzungsprotokolle, Projektdateien, privaten URLs, Zugangsdaten, Modellnutzung, Nutzungsstatistiken oder gerätespezifische Einstellungen. Speichern Sie den Token in einer lokalen Datei mit Modus `600` und verwenden Sie ein HTTPS-Gateway.

## Schnellstart

```bash
git clone https://github.com/seehow624/pi-web.git
cd pi-web
mkdir -p ~/.config/pi-web
openssl rand -hex 32 > ~/.config/pi-web/token
chmod 600 ~/.config/pi-web/token
PI_WEB_TOKEN_FILE="$HOME/.config/pi-web/token" node server.js
```

Pi Web auf jedem Computer starten und mit HTTPS-Adresse und lokalem Token anmelden. Token niemals in Git, Chats, Screenshots oder Logs ablegen.

Unter **Settings → Devices** lassen sich weitere Computer hinzufügen. Die launchd-Vorlagen in `deploy/` unterstützen automatische Updates.

```bash
npm run check
npm test
```

Weitere Informationen stehen in der [englischen Dokumentation](README.md).
