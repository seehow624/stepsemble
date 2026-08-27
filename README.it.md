# Pi Harbor (Italiano)

[English](README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · Italiano

Pi Harbor è un client web open source, progettato prima di tutto per dispositivi mobili, per Pi coding agent. Consente di vedere e continuare le sessioni, avviare progetti, visualizzare immagini e passare tra più computer Pi Harbor.

## Privacy

Il repository contiene solo il codice dell'applicazione e modelli di distribuzione generici. Non contiene token, log delle sessioni, file di progetto, URL privati, credenziali, cronologia dei modelli usati, statistiche di utilizzo o configurazioni specifiche di un computer. Conserva il token in un file locale con permessi `600` e usa un gateway HTTPS.

## Avvio rapido

```bash
git clone https://github.com/seehow624/pi-harbor.git
cd pi-harbor
mkdir -p ~/.config/pi-web
openssl rand -hex 32 > ~/.config/pi-web/token
chmod 600 ~/.config/pi-web/token
PI_WEB_TOKEN_FILE="$HOME/.config/pi-web/token" node server.js
```

Avvia Pi Harbor su ogni computer e accedi con l'URL HTTPS e il token locale. Non inserire mai il token in Git, chat, schermate o log.

Aggiungi computer in **Settings → Devices**. I modelli launchd in `deploy/` supportano gli aggiornamenti automatici.

```bash
npm run check
npm test
```

Per i dettagli consulta la [documentazione inglese](README.md).
