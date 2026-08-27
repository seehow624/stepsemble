# Pi Harbor (Deutsch)

[English](README.md) · [Vereinfachtes Chinesisch](README.zh-Hans.md) · [Traditionelles Chinesisch](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Français](README.fr.md) · Deutsch · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Pi Harbor ist ein quelloffener, mobil optimierter Webclient für Pi coding agent. Sitzungen können angezeigt und fortgesetzt, Projekte gestartet, Bilder angesehen und mehrere Pi Harbor-Computer gewechselt werden.

## Datenschutz

Das Repository enthält nur Anwendungscode und allgemeine Bereitstellungsvorlagen. Es enthält keine Token, Sitzungsprotokolle, Projektdateien, privaten URLs, Zugangsdaten, Modellnutzung, Nutzungsstatistiken oder gerätespezifische Einstellungen. Speichern Sie den Token in einer lokalen Datei mit Modus `600` und verwenden Sie ein HTTPS-Gateway.

## Schnellstart

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/pi-harbor/master/install.sh)"
```

Pi Harbor auf jedem Computer starten und mit HTTPS-Adresse und lokalem Token anmelden. Token niemals in Git, Chats, Screenshots oder Logs ablegen.

Unter **Settings → Devices** lassen sich weitere Computer hinzufügen. Die launchd-Vorlagen in `deploy/` unterstützen automatische Updates.

```bash
npm run check
npm test
```

Weitere Informationen stehen in der [englischen Dokumentation](README.md).
