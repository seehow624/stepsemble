# Stepsemble (Italiano)

[English](README.md) · [Cinese semplificato](README.zh-Hans.md) · [Cinese tradizionale](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · Italiano

Stepsemble è uno spazio di lavoro open source, self-hosted e mobile-first per coding agent locali. Oltre alle sessioni native di Pi Agent, può avviare Claude Code, Codex CLI, Grok Build e OpenCode installati sull'host.

## Privacy

Il repository contiene solo il codice dell'applicazione e modelli di distribuzione generici. Non contiene token, log delle sessioni, file di progetto, URL privati, credenziali, cronologia dei modelli usati, statistiche di utilizzo o configurazioni specifiche di un computer. Conserva il token in un file locale con permessi `600` e usa un gateway HTTPS.

## Avvio rapido

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/stepsemble/master/install.sh)"
```

Sul computer che esegue Stepsemble, apri Terminale ed esegui:

```bash
cat ~/.config/stepsemble/token
```

Incolla il token nella schermata di accesso. Da un altro dispositivo, recuperalo in modo sicuro da quell’host. Se `STEPSEMBLE_TOKEN_FILE` è stato configurato esplicitamente, leggi il file configurato invece del percorso predefinito. Non inserire mai il token in Git, chat, schermate o log.

Alla prima apertura di Stepsemble in un browser sul computer host stesso, viene offerta una rivelazione una tantum della chiave privata, in stile hardware wallet, prima dell’accesso. Viene mostrata solo su connessioni loopback — mai tramite Tailscale Serve, un proxy o un dispositivo remoto — e scompare per sempre dopo il salvataggio delle due conferme. Gli altri dispositivi usano sempre la chiave registrata o il file del token.

### Token di accesso aggiuntivi

Se un host è condiviso da più persone o dispositivi, apri **Settings → Access tokens** usando il token master dell’installazione per emettere token con etichetta. Ogni token viene mostrato una sola volta, può essere revocato separatamente e sul server viene salvato solo l’hash SHA-256 in `~/.config/stepsemble/tokens.json` (modalità `600`). Non crea account Pi o permessi di progetto separati.

Installa e avvia Stepsemble su ogni computer e aggiungi un indirizzo Tailscale o HTTPS in **Settings → Devices → Add device**. L’inserimento manuale dell’URL mantiene il percorso legacy con token Web condiviso e richiede lo stesso token sui due host. Un codice `STEPSEMBLE3` usa-e-getta, valido cinque minuti, crea dopo la verifica del candidato una credenziale peer indipendente e revocabile; il token condiviso non viene inviato all’URL candidato. I dispositivi autorizzati possono essere elencati e revocati nelle impostazioni, con effetto immediato. Stepsemble 3 accetta i codici `PIHARBOR2` / `PIHARBOR3` degli host precedenti; i client più vecchi devono aggiornarsi prima di usare `STEPSEMBLE3`. Non esporre la porta 3140. In **Settings → Connection → Models & providers** scegli un servizio del catalogo, account/OAuth, chiave API, servizio locale o provider personalizzato, quindi seleziona i modelli visibili. I modelli launchd in `deploy/` supportano gli aggiornamenti automatici.

```bash
npm run check
npm test
```

Per i dettagli consulta la [documentazione inglese](README.md).
