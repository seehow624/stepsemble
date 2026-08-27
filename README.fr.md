# Pi Harbor (Français)

[English](README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · Français · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Pi Harbor est un client Web open source, pensé d'abord pour le mobile, destiné à Pi coding agent. Il permet de consulter et poursuivre des sessions, créer des projets, prévisualiser des images et changer d'ordinateur Pi Harbor.

## Confidentialité

Le dépôt contient uniquement le code de l'application et des modèles de déploiement génériques. Il ne contient aucun token, journal de session, fichier de projet, URL privée, identifiant, historique d'utilisation de modèles, statistiques d'usage ni configuration propre à une machine. Conservez le token dans un fichier local en mode `600` et utilisez une passerelle HTTPS.

## Démarrage rapide

```bash
git clone https://github.com/seehow624/pi-harbor.git
cd pi-harbor
mkdir -p ~/.config/pi-web
openssl rand -hex 32 > ~/.config/pi-web/token
chmod 600 ~/.config/pi-web/token
PI_WEB_TOKEN_FILE="$HOME/.config/pi-web/token" node server.js
```

Lancez Pi Harbor sur chaque ordinateur, puis connectez-vous avec son URL HTTPS et son token local. Ne placez jamais le token dans Git, un chat, une capture ou un journal.

Ajoutez des ordinateurs dans **Settings → Devices**. Les modèles launchd de `deploy/` permettent les mises à jour automatiques.

```bash
npm run check
npm test
```

Consultez la [documentation anglaise](README.md) pour les détails.
