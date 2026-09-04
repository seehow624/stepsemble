# Stepsemble (Deutsch)

[English](README.md) · [Vereinfachtes Chinesisch](README.zh-Hans.md) · [Traditionelles Chinesisch](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Français](README.fr.md) · Deutsch · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Stepsemble ist ein quelloffener, selbst gehosteter und mobil optimierter Arbeitsbereich für lokale Coding-Agents. Neben nativen Pi-Agent-Sitzungen kann dieselbe Oberfläche auch installiertes Claude Code, Codex CLI, Grok Build und OpenCode starten.

## Datenschutz

Das Repository enthält nur Anwendungscode und allgemeine Bereitstellungsvorlagen. Es enthält keine Token, Sitzungsprotokolle, Projektdateien, privaten URLs, Zugangsdaten, Modellnutzung, Nutzungsstatistiken oder gerätespezifische Einstellungen. Speichern Sie den Token in einer lokalen Datei mit Modus `600` und verwenden Sie ein HTTPS-Gateway.

## Schnellstart

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/stepsemble/master/install.sh)"
```

Öffnen Sie auf dem Computer, auf dem Stepsemble läuft, das Terminal und führen Sie Folgendes aus:

```bash
cat ~/.config/stepsemble/token
```

Fügen Sie das Token auf der Anmeldeseite ein. Rufen Sie es auf einem anderen Gerät sicher von diesem Host ab. Wenn `STEPSEMBLE_TOKEN_FILE` ausdrücklich konfiguriert ist, lesen Sie die konfigurierte Datei statt des Standardpfads. Speichern Sie das Token niemals in Git, Chats, Screenshots oder Protokollen.

Wenn Stepsemble zum ersten Mal in einem Browser auf dem Host-Computer selbst geöffnet wird, bietet eine Einmal-Anzeige im Hardware-Wallet-Stil den privaten Zugangsschlüssel vor der Anmeldung an. Er wird nur über Loopback-Verbindungen angezeigt — niemals über Tailscale Serve, einen Proxy oder ein entferntes Gerät — und verschwindet dauerhaft, nachdem beide Bestätigungen gespeichert wurden. Andere Geräte verwenden stets den gesicherten Schlüssel oder die Token-Datei.

### Zusätzliche Zugriffstoken

Wenn ein Host von mehreren Personen oder Geräten verwendet wird, öffnen Sie mit dem Installations-/Master-Token **Settings → Access tokens**, um beschriftete Token auszustellen. Ein Token wird nur einmal angezeigt, kann einzeln widerrufen werden und wird nur als SHA-256-Hash in `~/.config/stepsemble/tokens.json` (Modus `600`) gespeichert. Dadurch entstehen keine separaten Pi-Konten oder Projektberechtigungen.

Installieren und starten Sie Stepsemble auf jedem Computer und fügen Sie unter **Settings → Devices → Add device** eine Tailscale- oder HTTPS-Adresse hinzu. Die manuelle URL-Eingabe bleibt der alte Weg mit gemeinsamem Web-Token und erfordert dasselbe Token auf beiden Hosts. Ein fünf Minuten gültiger, einmaliger `STEPSEMBLE3`-Kopplungscode erstellt nach der Prüfung des Ziels eine unabhängige, widerrufbare Peer-Anmeldung; das gemeinsame Token wird nicht an die Ziel-URL gesendet. Autorisierte Geräte lassen sich in den Geräteeinstellungen anzeigen und sofort widerrufen. Stepsemble 3 akzeptiert `PIHARBOR2` / `PIHARBOR3`-Codes von älteren Hosts; ältere Clients müssen vor `STEPSEMBLE3` aktualisiert werden. Geben Sie Port 3140 nicht frei. Unter **Settings → Connection → Models & providers** können Sie einen Katalogdienst, Konto/OAuth, einen API-Schlüssel, einen lokalen Dienst oder einen benutzerdefinierten Anbieter wählen und anschließend sichtbare Modelle auswählen. Die launchd-Vorlagen in `deploy/` unterstützen automatische Updates.

```bash
npm run check
npm test
```

Weitere Informationen stehen in der [englischen Dokumentation](README.md).
