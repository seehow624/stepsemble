# Pi Harbor (Deutsch)

[English](README.md) · [Vereinfachtes Chinesisch](README.zh-Hans.md) · [Traditionelles Chinesisch](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Français](README.fr.md) · Deutsch · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Pi Harbor ist ein quelloffener, mobil optimierter Webclient für Pi coding agent. Sitzungen können angezeigt und fortgesetzt, Projekte gestartet, Bilder angesehen und mehrere Pi Harbor-Computer gewechselt werden.

## Datenschutz

Das Repository enthält nur Anwendungscode und allgemeine Bereitstellungsvorlagen. Es enthält keine Token, Sitzungsprotokolle, Projektdateien, privaten URLs, Zugangsdaten, Modellnutzung, Nutzungsstatistiken oder gerätespezifische Einstellungen. Speichern Sie den Token in einer lokalen Datei mit Modus `600` und verwenden Sie ein HTTPS-Gateway.

## Schnellstart

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/pi-harbor/master/install.sh)"
```

Öffnen Sie auf dem Computer, auf dem Pi Harbor läuft, das Terminal und führen Sie Folgendes aus:

```bash
cat ~/.config/pi-harbor/token
```

Fügen Sie das Token auf der Anmeldeseite ein. Rufen Sie es auf einem anderen Gerät sicher von diesem Host ab. Wenn `PI_HARBOR_TOKEN_FILE` ausdrücklich konfiguriert ist, lesen Sie die konfigurierte Datei statt des Standardpfads. Speichern Sie das Token niemals in Git, Chats, Screenshots oder Protokollen.

Wenn Pi Harbor zum ersten Mal in einem Browser auf dem Host-Computer selbst geöffnet wird, bietet eine Einmal-Anzeige im Hardware-Wallet-Stil den privaten Zugangsschlüssel vor der Anmeldung an. Er wird nur über Loopback-Verbindungen angezeigt — niemals über Tailscale Serve, einen Proxy oder ein entferntes Gerät — und verschwindet dauerhaft, nachdem beide Bestätigungen gespeichert wurden. Andere Geräte verwenden stets den gesicherten Schlüssel oder die Token-Datei.

Installieren und starten Sie Pi Harbor auf jedem Computer und fügen Sie unter **Settings → Devices → Add device** eine Tailscale- oder HTTPS-Adresse hinzu. Alternativ können Sie einen fünf Minuten gültigen Kopplungscode verwenden. Verwenden Sie dasselbe Web-Token. Kopplungscodes werden per HMAC authentifiziert; aktualisieren Sie beide Computer, bevor Sie einen neuen Code erzeugen. Das gemeinsame Web-Token wird niemals an eine ungeprüfte Ziel-URL gesendet. Geben Sie Port 3140 nicht frei. Unter **Settings → Connection → Models & providers** können Sie einen Katalogdienst, Konto/OAuth, einen API-Schlüssel, einen lokalen Dienst oder einen benutzerdefinierten Anbieter wählen und anschließend sichtbare Modelle auswählen. Die launchd-Vorlagen in `deploy/` unterstützen automatische Updates.

```bash
npm run check
npm test
```

Weitere Informationen stehen in der [englischen Dokumentation](README.md).
