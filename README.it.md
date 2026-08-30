# Pi Harbor (Italiano)

[English](README.md) · [Cinese semplificato](README.zh-Hans.md) · [Cinese tradizionale](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · Italiano

Pi Harbor è un client web open source, progettato prima di tutto per dispositivi mobili, per Pi coding agent. Consente di vedere e continuare le sessioni, avviare progetti, visualizzare immagini e passare tra più computer Pi Harbor.

## Privacy

Il repository contiene solo il codice dell'applicazione e modelli di distribuzione generici. Non contiene token, log delle sessioni, file di progetto, URL privati, credenziali, cronologia dei modelli usati, statistiche di utilizzo o configurazioni specifiche di un computer. Conserva il token in un file locale con permessi `600` e usa un gateway HTTPS.

## Avvio rapido

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/pi-harbor/master/install.sh)"
```

Sul computer che esegue Pi Harbor, apri Terminale ed esegui:

```bash
cat ~/.config/pi-harbor/token
```

Incolla il token nella schermata di accesso. Da un altro dispositivo, recuperalo in modo sicuro da quell’host. Se `PI_HARBOR_TOKEN_FILE` è stato configurato esplicitamente, leggi il file configurato invece del percorso predefinito. Non inserire mai il token in Git, chat, schermate o log.

Alla prima apertura di Pi Harbor in un browser sul computer host stesso, viene offerta una rivelazione una tantum della chiave privata, in stile hardware wallet, prima dell’accesso. Viene mostrata solo su connessioni loopback — mai tramite Tailscale Serve, un proxy o un dispositivo remoto — e scompare per sempre dopo il salvataggio delle due conferme. Gli altri dispositivi usano sempre la chiave registrata o il file del token.

Installa e avvia Pi Harbor su ogni computer e aggiungi un indirizzo Tailscale o HTTPS in **Settings → Devices → Add device**. L’inserimento manuale dell’URL mantiene il percorso legacy con token Web condiviso e richiede lo stesso token sui due host. Un codice `PIHARBOR3` usa-e-getta, valido cinque minuti, crea dopo la verifica del candidato una credenziale peer indipendente e revocabile; il token condiviso non viene inviato all’URL candidato. I dispositivi autorizzati possono essere elencati e revocati nelle impostazioni, con effetto immediato. Pi Harbor 2.2 accetta i codici `PIHARBOR2` degli host 2.1.2; i client più vecchi devono aggiornarsi prima di usare `PIHARBOR3`. Non esporre la porta 3140. In **Settings → Connection → Models & providers** scegli un servizio del catalogo, account/OAuth, chiave API, servizio locale o provider personalizzato, quindi seleziona i modelli visibili. I modelli launchd in `deploy/` supportano gli aggiornamenti automatici.

```bash
npm run check
npm test
```

Per i dettagli consulta la [documentazione inglese](README.md).
